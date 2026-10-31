#include "history-filesystem.h"
#include <cerrno>
#include <cstdio>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
// Raw syscalls keep the slot under its glibc floor and need no kernel headers.
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef SYS_renameat2
#if defined(__x86_64__)
#define SYS_renameat2 316
#elif defined(__aarch64__)
#define SYS_renameat2 276
#else
#error "renameat2 syscall number unknown for this architecture"
#endif
#endif
#endif

namespace history {
static Failure failure(const char* op, int code = errno) {
  const char* name = "EIO";
  switch (code) {
    case EEXIST: name = "EEXIST"; break;
    case ENOENT: name = "ENOENT"; break;
    case ENOTDIR: name = "ENOTDIR"; break;
    case ELOOP: name = "ELOOP"; break;
    case EXDEV: name = "EXDEV"; break;
    case EACCES: name = "EACCES"; break;
    case EPERM: name = "EPERM"; break;
    case EBUSY: name = "EBUSY"; break;
    case ENOTEMPTY: name = "ENOTEMPTY"; break;
    case ENOSYS: name = "ENOSYS"; break;
    case EOPNOTSUPP: name = "ENOTSUP"; break;
#if ENOTSUP != EOPNOTSUPP
    case ENOTSUP: name = "ENOTSUP"; break;
#endif
    case EINVAL: name = "EINVAL"; break;
    case ENOSPC: name = "ENOSPC"; break;
    case EDQUOT: name = "EDQUOT"; break;
    case EROFS: name = "EROFS"; break;
    case ENAMETOOLONG: name = "ENAMETOOLONG"; break;
  }
  return Failure(op, name, code);
}
static int fd(Directory& directory) { return static_cast<int>(directory.handle()); }
// glibc 2.33 versioned fstat/fstatat, so the glibc slots call the kernel; x86_64 and aarch64 share its struct stat layout.
#if defined(__linux__) && defined(__GLIBC__) && (defined(__x86_64__) || defined(__aarch64__))
#define HISTORY_RAW_STAT 1
#endif
static int statAt(int descriptor, const char* name, struct stat* value, int flags) {
#ifdef HISTORY_RAW_STAT
  return static_cast<int>(syscall(SYS_newfstatat, descriptor, name, value, flags));
#else
  return fstatat(descriptor, name, value, flags);
#endif
}
static struct stat info(Directory& directory) {
  struct stat value;
#ifdef HISTORY_RAW_STAT
  int result = static_cast<int>(syscall(SYS_fstat, fd(directory), &value));
#else
  int result = fstat(fd(directory), &value);
#endif
  if (result != 0) throw failure("fstat");
  return value;
}
std::unique_ptr<Directory> Directory::root(const std::string& path, bool follow) {
  int result = ::open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | (follow ? 0 : O_NOFOLLOW));
  if (result < 0) throw failure("open-root");
  return std::make_unique<Directory>(result);
}
std::unique_ptr<Directory> Directory::open(const std::string& name) {
  int result = openat(fd(*this), name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (result < 0) throw failure("openat");
  return std::make_unique<Directory>(result);
}
std::vector<std::string> Directory::entries() {
  // A new open description avoids sharing the enumeration offset with previous passes.
  int copy = openat(fd(*this), ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (copy < 0) throw failure("open-enumeration");
  DIR* raw = fdopendir(copy);
  if (!raw) { int saved = errno; ::close(copy); throw failure("fdopendir", saved); }
  std::unique_ptr<DIR, decltype(&closedir)> directory(raw, closedir);
  std::vector<std::string> names;
  errno = 0;
  while (auto entry = readdir(directory.get())) {
    std::string name(entry->d_name);
    if (name != "." && name != "..") names.push_back(name);
    errno = 0;
  }
  if (errno) throw failure("readdir");
  return names;
}
Kind Directory::kind(const std::string& name) {
  struct stat value;
  if (statAt(fd(*this), name.c_str(), &value, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return Kind::Missing;
    throw failure("fstatat");
  }
  if (S_ISLNK(value.st_mode)) return Kind::Link;
  if (S_ISDIR(value.st_mode)) return Kind::Directory;
  return S_ISREG(value.st_mode) ? Kind::File : Kind::Other;
}
void Directory::mkdir(const std::string& name, Directory* like) {
  // The owner must be able to fill the directory, whatever bits the source carried.
  mode_t mode = (like ? info(*like).st_mode & 07777 : 0777) | S_IRWXU;
  if (mkdirat(fd(*this), name.c_str(), mode) != 0) throw failure("mkdirat");
}
Move Directory::move(const std::string& name, Directory& destination, const std::string& target, bool /*directoryOnly*/) {
#ifdef __APPLE__
  int result = renameatx_np(fd(*this), name.c_str(), fd(destination), target.c_str(), RENAME_EXCL);
#else
  int result = static_cast<int>(syscall(SYS_renameat2, fd(*this), name.c_str(), fd(destination), target.c_str(), RENAME_NOREPLACE));
#endif
  if (result == 0) return Move::Moved;
  int saved = errno;
  if (saved == EEXIST) return Move::Collision;
  if (saved == ENOENT && kind(name) == Kind::Missing) return Move::Missing;
  throw failure("rename-exclusive", saved);
}
void Directory::link(const std::string& name, const std::string& target) {
  if (symlinkat(target.c_str(), fd(*this), name.c_str()) != 0) throw failure("symlinkat");
}
std::string Directory::readLink(const std::string& name) {
  std::vector<char> buffer(256);
  for (;;) {
    auto size = readlinkat(fd(*this), name.c_str(), buffer.data(), buffer.size());
    if (size < 0) throw failure("readlinkat");
    if (static_cast<size_t>(size) < buffer.size()) return std::string(buffer.data(), size);
    buffer.resize(buffer.size() * 2);
  }
}
void Directory::removeEmpty(const std::string& name) {
  if (unlinkat(fd(*this), name.c_str(), AT_REMOVEDIR) != 0) throw failure("unlinkat-directory");
}
bool Directory::same(Directory& other) { auto a = info(*this), b = info(other); return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
bool Directory::sameDevice(Directory& other) { return info(*this).st_dev == info(other).st_dev; }
void Directory::close() { if (handle_ != -1) { ::close(static_cast<int>(handle_)); handle_ = -1; } }
}
