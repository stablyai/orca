/*
 * Holds the standard SQLite main-file lock without opening or modifying SQLite, and on request
 * removes the journal while still holding it, so no SQLite connection can open or write the
 * file between the last check and the removal.
 *
 *   journal-file-lock <main> --check   prints "eligible" when the file may be locked here
 *   journal-file-lock <main>           prints "locked"; then a "retire <wal bytes>" line on stdin
 *                                      removes the main file, a -wal of exactly that size (the
 *                                      caller proved its frames were absorbed) and the -shm, and
 *                                      prints "retired". End of input releases the lock untouched.
 *
 * Exit codes: 0 done, 2 usage, 3 open/stat failed, 4 unsupported file or storage, 5 close
 * failed, 6 lock held by another process, 7 companions not removable (main kept), 8 removal
 * failed.
 */
#ifdef _WIN32
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/* Returns 1 for "retire <bytes>", storing the WAL size the caller absorbed. */
static int read_command(unsigned long long *wal) {
  char line[64];
  const char *p = line + 7;
  if (!fgets(line, sizeof line, stdin) || strncmp(line, "retire ", 7) != 0) return 0;
  if (*p < '0' || *p > '9') return 0;
  *wal = 0;
  for (; *p >= '0' && *p <= '9'; p++) {
    if (*wal > (~0ULL - 9) / 10) return 0;
    *wal = *wal * 10 + (unsigned long long)(*p - '0');
  }
  /* Sizes are compared as signed file offsets, where a negative one would mean "any size". */
  if (*wal > 0x7fffffffffffffffULL) return 0;
  return strcmp(p, "\n") == 0 || strcmp(p, "\r\n") == 0;
}

/* A companion may be absent; a WAL is removed only at exactly the size the caller absorbed. */
static int companion_ok(const wchar_t *main, const wchar_t *suffix, long long size) {
  wchar_t name[32768];
  if (swprintf(name, 32768, L"%ls%ls", main, suffix) < 0) return 0;
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExW(name, GetFileExInfoStandard, &data)) {
    return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
  }
  if (data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
  return size < 0 ||
         (((unsigned long long)data.nFileSizeHigh << 32) | data.nFileSizeLow) ==
             (unsigned long long)size;
}

static int remove_companion(const wchar_t *main, const wchar_t *suffix) {
  wchar_t name[32768];
  if (swprintf(name, 32768, L"%ls%ls", main, suffix) < 0) return 0;
  return DeleteFileW(name) || GetLastError() == ERROR_FILE_NOT_FOUND;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2 && argc != 3) return 2;
  int check = argc == 3 && wcscmp(argv[2], L"--check") == 0;
  if (argc == 3 && !check) return 2;
  /* Sharing only delete keeps every other opener, SQLite included, out while this is held. */
  HANDLE file = CreateFileW(argv[1], check ? FILE_READ_ATTRIBUTES : GENERIC_READ | DELETE,
                           check ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_SHARING_VIOLATION ? 6 : 3;
  BY_HANDLE_FILE_INFORMATION info;
  wchar_t fs[32], volume[MAX_PATH], final[32768];
  DWORD final_length = GetFinalPathNameByHandleW(file, final, 32768, FILE_NAME_NORMALIZED);
  if (!GetFileInformationByHandle(file, &info) || final_length == 0 || final_length >= 32768 ||
      !GetVolumePathNameW(final, volume, MAX_PATH) ||
      !GetVolumeInformationByHandleW(file, NULL, 0, NULL, NULL, NULL, fs, 32)) {
    CloseHandle(file); return 3;
  }
  if (info.nNumberOfLinks != 1 ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      GetDriveTypeW(volume) != DRIVE_FIXED || wcscmp(fs, L"NTFS") != 0) {
    CloseHandle(file); return 4;
  }
  HANDLE named = CreateFileW(argv[1], 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION current;
  int same = named != INVALID_HANDLE_VALUE && GetFileInformationByHandle(named, &current) &&
             current.dwVolumeSerialNumber == info.dwVolumeSerialNumber &&
             current.nFileIndexHigh == info.nFileIndexHigh && current.nFileIndexLow == info.nFileIndexLow;
  if (named != INVALID_HANDLE_VALUE && !CloseHandle(named)) same = 0;
  if (!same) { CloseHandle(file); return 4; }
  if (check) {
    puts("eligible"); fflush(stdout);
    return CloseHandle(file) ? 0 : 5;
  }
  puts("locked"); fflush(stdout);
  unsigned long long wal = 0;
  if (!read_command(&wal)) {
    return CloseHandle(file) ? 0 : 5;
  }
  /* A rollback journal of any size means an interrupted transaction: keep everything. */
  {
    wchar_t rollback[32768];
    if (swprintf(rollback, 32768, L"%ls-journal", argv[1]) < 0 ||
        GetFileAttributesW(rollback) != INVALID_FILE_ATTRIBUTES ||
        !companion_ok(argv[1], L"-wal", (long long)wal) || !companion_ok(argv[1], L"-shm", -1)) {
      CloseHandle(file); return 7;
    }
  }
  /* The held handle is the only one, so closing it removes the file. */
  FILE_DISPOSITION_INFO disposition = { TRUE };
  if (!SetFileInformationByHandle(file, FileDispositionInfo, &disposition, sizeof disposition)) {
    CloseHandle(file); return 8;
  }
  if (!CloseHandle(file)) return 8;
  if (!remove_companion(argv[1], L"-wal") || !remove_companion(argv[1], L"-shm")) return 8;
  puts("retired"); fflush(stdout);
  return 0;
}
#else
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/mount.h>
#else
#include <sys/vfs.h>
#endif

/* Returns 1 for "retire <bytes>", storing the WAL size the caller absorbed. */
static int read_command(unsigned long long *wal) {
  char line[64];
  const char *p = line + 7;
  if (!fgets(line, sizeof line, stdin) || strncmp(line, "retire ", 7) != 0) return 0;
  if (*p < '0' || *p > '9') return 0;
  *wal = 0;
  for (; *p >= '0' && *p <= '9'; p++) {
    if (*wal > (~0ULL - 9) / 10) return 0;
    *wal = *wal * 10 + (unsigned long long)(*p - '0');
  }
  /* Sizes are compared as signed file offsets, where a negative one would mean "any size". */
  if (*wal > 0x7fffffffffffffffULL) return 0;
  return strcmp(p, "\n") == 0 || strcmp(p, "\r\n") == 0;
}

/* 1 when absent or acceptable (size < 0: any size), 0 when it blocks removal. */
static int companion_ok(const char *main, const char *suffix, long long size) {
  char name[PATH_MAX];
  struct stat info;
  if (snprintf(name, sizeof name, "%s%s", main, suffix) >= (int)sizeof name) return 0;
  if (lstat(name, &info) != 0) return errno == ENOENT;
  return S_ISREG(info.st_mode) && (size < 0 || (long long)info.st_size == size);
}

static int remove_companion(const char *main, const char *suffix) {
  char name[PATH_MAX];
  if (snprintf(name, sizeof name, "%s%s", main, suffix) >= (int)sizeof name) return 0;
  return unlink(name) == 0 || errno == ENOENT;
}

static int sync_directory(const char *main) {
  char copy[PATH_MAX];
  if (snprintf(copy, sizeof copy, "%s", main) >= (int)sizeof copy) return 0;
  int dir = open(dirname(copy), O_RDONLY | O_CLOEXEC);
  if (dir < 0) return 0;
#ifdef __APPLE__
  int synced = fcntl(dir, F_FULLFSYNC) == 0 || fsync(dir) == 0;
#else
  int synced = fsync(dir) == 0;
#endif
  return close(dir) == 0 && synced;
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  int check = argc == 3 && strcmp(argv[2], "--check") == 0;
  if (argc == 3 && !check) return 2;
  int fd = open(argv[1], (check ? O_RDONLY : O_RDWR) | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 3;
  struct stat info, named;
  struct statfs volume;
  int local = 0;
  if (fstatfs(fd, &volume) != 0) { close(fd); return 3; }
  {
#ifdef __APPLE__
    local = strcmp(volume.f_fstypename, "apfs") == 0 || strcmp(volume.f_fstypename, "hfs") == 0;
#else
    local = volume.f_type == 0xef53 || volume.f_type == 0x58465342 ||
            volume.f_type == 0x9123683e || volume.f_type == 0x2fc12fc1;
#endif
  }
  /* SQLite's pending, reserved and shared bytes: no connection can read or write while held. */
  struct flock lock = {0};
  lock.l_type = F_WRLCK; lock.l_whence = SEEK_SET;
  lock.l_start = 0x40000000; lock.l_len = 512;
  if (fstat(fd, &info) || lstat(argv[1], &named)) { close(fd); return 3; }
  if (!local || !S_ISREG(info.st_mode) || info.st_nlink != 1 ||
      info.st_dev != named.st_dev || info.st_ino != named.st_ino) {
    close(fd); return 4;
  }
  if (check) {
    puts("eligible"); fflush(stdout);
    return close(fd) == 0 ? 0 : 5;
  }
  if (fcntl(fd, F_SETLK, &lock)) { close(fd); return 6; }
  if (lstat(argv[1], &named) || info.st_dev != named.st_dev || info.st_ino != named.st_ino) {
    close(fd); return 4;
  }
  puts("locked"); fflush(stdout);
  unsigned long long wal = 0;
  if (!read_command(&wal)) {
    return close(fd) == 0 ? 0 : 5;
  }
  /* Still holding the lock: the path must name the locked file, with nothing pending beside it. */
  if (lstat(argv[1], &named) || info.st_dev != named.st_dev || info.st_ino != named.st_ino) {
    close(fd); return 4;
  }
  if (!companion_ok(argv[1], "-wal", (long long)wal) || !companion_ok(argv[1], "-shm", -1)) {
    close(fd); return 7;
  }
  /* A rollback journal of any size means an interrupted transaction: keep everything. */
  {
    char rollback[PATH_MAX];
    struct stat ignored;
    if (snprintf(rollback, sizeof rollback, "%s-journal", argv[1]) >= (int)sizeof rollback ||
        lstat(rollback, &ignored) == 0 || errno != ENOENT) {
      close(fd); return 7;
    }
  }
  if (unlink(argv[1]) != 0) { close(fd); return 8; }
  if (!remove_companion(argv[1], "-wal") || !remove_companion(argv[1], "-shm") ||
      !sync_directory(argv[1])) {
    close(fd); return 8;
  }
  puts("retired"); fflush(stdout);
  return close(fd) == 0 ? 0 : 5;
}
#endif
