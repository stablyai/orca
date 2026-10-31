#include "history-filesystem.h"
#include <windows.h>
#include <winternl.h>
#include <winioctl.h>
#include <cstddef>
#include <cstring>
#include <limits>

namespace history {
static Failure failure(const char* op, DWORD value = GetLastError()) {
  const char* code = "EIO";
  switch (value) {
    case ERROR_FILE_EXISTS: case ERROR_ALREADY_EXISTS: code = "EEXIST"; break;
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: code = "ENOENT"; break;
    case ERROR_NOT_SAME_DEVICE: code = "EXDEV"; break;
    case ERROR_ACCESS_DENIED: code = "EACCES"; break;
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: code = "EBUSY"; break;
    case ERROR_DIR_NOT_EMPTY: code = "ENOTEMPTY"; break;
    case ERROR_DIRECTORY: code = "ENOTDIR"; break;
    case ERROR_NOT_SUPPORTED: case ERROR_INVALID_FUNCTION: code = "ENOTSUP"; break;
    case ERROR_INVALID_PARAMETER: code = "EINVAL"; break;
  }
  return Failure(op, code, value);
}
static std::wstring wide(const std::string& text) {
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!count) throw failure("utf8");
  std::wstring result(count, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
  return result;
}
static std::string utf8(const std::wstring& text) {
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!count && !text.empty()) throw failure("utf16");
  std::string result(count, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
  return result;
}
static HANDLE handle(Directory& directory) { return reinterpret_cast<HANDLE>(directory.handle()); }
struct CloseHandleDeleter { void operator()(void* value) const { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
using OwnedHandle = std::unique_ptr<void, CloseHandleDeleter>;
static OwnedHandle child(Directory& parent, const std::string& name, ACCESS_MASK access, ULONG disposition = 1, ULONG options = 0, ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE) {
  std::wstring path = wide(name);
  if (path.size() > std::numeric_limits<USHORT>::max() / sizeof(wchar_t)) throw failure("entry-name", ERROR_INVALID_PARAMETER);
  UNICODE_STRING unicode;
  unicode.Buffer = path.data(); unicode.Length = static_cast<USHORT>(path.size() * sizeof(wchar_t)); unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &unicode, OBJ_CASE_INSENSITIVE, handle(parent), nullptr);
  HANDLE result = INVALID_HANDLE_VALUE;
  IO_STATUS_BLOCK status;
  // FILE_OPEN_REPARSE_POINT is type-neutral: inspect the opened entry before traversal.
  NTSTATUS code = NtCreateFile(&result, access | SYNCHRONIZE, &attributes, &status, nullptr,
      FILE_ATTRIBUTE_NORMAL, share, disposition, options | 0x00200000 | 0x00000020, nullptr, 0);
  if (code < 0) throw failure("NtCreateFile", RtlNtStatusToDosError(code));
  return OwnedHandle(result);
}
static FILE_ATTRIBUTE_TAG_INFO tag(HANDLE value) {
  FILE_ATTRIBUTE_TAG_INFO result;
  if (!GetFileInformationByHandleEx(value, FileAttributeTagInfo, &result, sizeof(result))) throw failure("FileAttributeTagInfo");
  return result;
}
static void requireDirectory(HANDLE value) {
  auto attrs = tag(value);
  if (!(attrs.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (attrs.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw failure("open-directory", ERROR_DIRECTORY);
}
static BY_HANDLE_FILE_INFORMATION info(Directory& directory) {
  BY_HANDLE_FILE_INFORMATION result;
  if (!GetFileInformationByHandle(handle(directory), &result)) throw failure("GetFileInformationByHandle");
  return result;
}
std::unique_ptr<Directory> Directory::root(const std::string& path, bool follow) {
  auto text = wide(path);
  OwnedHandle opened(CreateFileW(text.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), nullptr));
  if (opened.get() == INVALID_HANDLE_VALUE) throw failure("CreateFile-root");
  requireDirectory(opened.get());
  return std::make_unique<Directory>(reinterpret_cast<intptr_t>(opened.release()));
}
std::unique_ptr<Directory> Directory::open(const std::string& name) {
  auto opened = child(*this, name, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES);
  requireDirectory(opened.get());
  return std::make_unique<Directory>(reinterpret_cast<intptr_t>(opened.release()));
}
std::vector<std::string> Directory::entries() {
  std::vector<std::string> result;
  std::vector<BYTE> bytes(64 * 1024);
  bool restart = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(handle(*this), restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, bytes.data(), static_cast<DWORD>(bytes.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      throw failure("enumerate-directory");
    }
    restart = false;
    auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(bytes.data());
    for (;;) {
      auto name = utf8(std::wstring(entry->FileName, entry->FileNameLength / sizeof(wchar_t)));
      if (name != "." && name != "..") result.push_back(name);
      if (!entry->NextEntryOffset) break;
      entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<BYTE*>(entry) + entry->NextEntryOffset);
    }
  }
  return result;
}
Kind Directory::kind(const std::string& name) {
  try {
    auto opened = child(*this, name, FILE_READ_ATTRIBUTES);
    auto attrs = tag(opened.get()).FileAttributes;
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) return Kind::Link;
    if (attrs & FILE_ATTRIBUTE_DIRECTORY) return Kind::Directory;
    return attrs & FILE_ATTRIBUTE_DEVICE ? Kind::Other : Kind::File;
  } catch (const Failure& error) { if (error.code == "ENOENT") return Kind::Missing; throw; }
}
void Directory::mkdir(const std::string& name) { auto created = child(*this, name, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, 2, 1); }
Move Directory::move(const std::string& name, Directory& destination, const std::string& target, bool directoryOnly) {
  OwnedHandle source;
  try {
    // DELETE without FILE_SHARE_DELETE prevents a rival relocating this source before consumption.
    source = child(*this, name, DELETE | FILE_READ_ATTRIBUTES, 1, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
  } catch (const Failure& error) { if (error.code == "ENOENT") return Move::Missing; throw; }
  if (directoryOnly) requireDirectory(source.get());
  auto text = wide(target);
  std::vector<BYTE> bytes(offsetof(FILE_RENAME_INFO, FileName) + text.size() * sizeof(wchar_t));
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());
  rename->ReplaceIfExists = FALSE; rename->RootDirectory = handle(destination); rename->FileNameLength = static_cast<DWORD>(text.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, text.data(), rename->FileNameLength);
  if (SetFileInformationByHandle(source.get(), FileRenameInfo, rename, static_cast<DWORD>(bytes.size()))) return Move::Moved;
  auto error = failure("FileRenameInfo");
  if (error.code == "EEXIST") return Move::Collision;
  throw error;
}
struct MountPoint { ULONG tag; USHORT length, reserved, subOffset, subLength, printOffset, printLength; wchar_t paths[1]; };
void Directory::link(const std::string& name, const std::string& target) {
  auto text = wide(target);
  std::wstring substitute = text;
  if (substitute.rfind(L"\\\\?\\", 0) == 0) substitute.replace(0, 4, L"\\??\\");
  else if (substitute.rfind(L"\\\\", 0) == 0) substitute = L"\\??\\UNC\\" + substitute.substr(2);
  else substitute = L"\\??\\" + substitute;
  auto payloadBytes = (substitute.size() + text.size() + 2) * sizeof(wchar_t);
  if (payloadBytes + offsetof(MountPoint, paths) > MAXIMUM_REPARSE_DATA_BUFFER_SIZE) throw failure("junction-target", ERROR_INVALID_PARAMETER);
  auto created = child(*this, name, GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES, 2, 1, FILE_SHARE_READ | FILE_SHARE_WRITE);
  std::vector<BYTE> bytes(offsetof(MountPoint, paths) + payloadBytes);
  auto* point = reinterpret_cast<MountPoint*>(bytes.data());
  point->tag = IO_REPARSE_TAG_MOUNT_POINT; point->length = static_cast<USHORT>(8 + payloadBytes);
  point->subLength = static_cast<USHORT>(substitute.size() * sizeof(wchar_t)); point->subOffset = 0;
  point->printOffset = point->subLength + sizeof(wchar_t); point->printLength = static_cast<USHORT>(text.size() * sizeof(wchar_t));
  std::memcpy(point->paths, substitute.c_str(), point->subLength + sizeof(wchar_t));
  std::memcpy(reinterpret_cast<BYTE*>(point->paths) + point->printOffset, text.c_str(), point->printLength + sizeof(wchar_t));
  DWORD returned;
  if (!DeviceIoControl(created.get(), FSCTL_SET_REPARSE_POINT, point, static_cast<DWORD>(bytes.size()), nullptr, 0, &returned, nullptr)) {
    auto error = failure("FSCTL_SET_REPARSE_POINT");
    FILE_DISPOSITION_INFO remove = {TRUE};
    (void)SetFileInformationByHandle(created.get(), FileDispositionInfo, &remove, sizeof(remove));
    throw error;
  }
}
std::string Directory::readLink(const std::string& name) {
  auto opened = child(*this, name, FILE_READ_ATTRIBUTES);
  std::vector<BYTE> bytes(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  DWORD returned;
  if (!DeviceIoControl(opened.get(), FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(), static_cast<DWORD>(bytes.size()), &returned, nullptr)) throw failure("FSCTL_GET_REPARSE_POINT");
  auto* point = reinterpret_cast<MountPoint*>(bytes.data());
  size_t start = offsetof(MountPoint, paths);
  USHORT offset, length;
  if (point->tag == IO_REPARSE_TAG_MOUNT_POINT) {
    offset = point->printOffset; length = point->printLength;
  } else if (point->tag == IO_REPARSE_TAG_SYMLINK) {
    // A symbolic-link payload has an extra Flags field before PathBuffer.
    start += sizeof(ULONG);
    offset = point->printOffset; length = point->printLength;
  } else { throw failure("read-directory-link", ERROR_NOT_SUPPORTED); }
  if (returned < start || offset + length > returned - start || (offset | length) % sizeof(wchar_t)) throw failure("read-directory-link", ERROR_INVALID_DATA);
  return utf8(std::wstring(reinterpret_cast<wchar_t*>(bytes.data() + start + offset), length / sizeof(wchar_t)));
}
void Directory::removeEmpty(const std::string& name) {
  auto opened = child(*this, name, DELETE | FILE_READ_ATTRIBUTES, 1, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
  requireDirectory(opened.get());
  FILE_DISPOSITION_INFO remove = {TRUE};
  if (!SetFileInformationByHandle(opened.get(), FileDispositionInfo, &remove, sizeof(remove))) throw failure("FileDispositionInfo");
}
bool Directory::same(Directory& other) { auto a = info(*this), b = info(other); return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow; }
bool Directory::sameDevice(Directory& other) { return info(*this).dwVolumeSerialNumber == info(other).dwVolumeSerialNumber; }
void Directory::close() { if (handle_ != -1) { CloseHandle(reinterpret_cast<HANDLE>(handle_)); handle_ = -1; } }
}
