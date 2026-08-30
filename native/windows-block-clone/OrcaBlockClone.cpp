#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <winioctl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "Ole32.lib")

namespace fs = std::filesystem;

namespace {

constexpr int ExitFailure = 1;
constexpr int ExitUnavailable = 2;
constexpr int ExitTargetExists = 3;
constexpr std::int64_t MaxCloneChunk = 1024LL * 1024LL * 1024LL;

class CloneUnavailableError final : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class TargetExistsError final : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class Handle final {
 public:
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~Handle() {
    if (valid()) {
      CloseHandle(value_);
    }
  }

  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.value_) {
    other.value_ = INVALID_HANDLE_VALUE;
  }

  bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE get() const { return value_; }

 private:
  HANDLE value_;
};

struct VolumeInfo {
  std::wstring name;
  std::wstring filesystem;
  std::int64_t clusterSize;
};

struct ClonePlan {
  std::vector<fs::path> directories{fs::path{}};
  std::vector<fs::path> files;
};

std::string ToUtf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }
  const int size = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0,
      nullptr, nullptr);
  if (size <= 0) {
    return "<unprintable path>";
  }
  std::string output(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                      output.data(), size, nullptr, nullptr);
  return output;
}

std::string WindowsErrorMessage(DWORD code) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, code, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  if (length == 0 || buffer == nullptr) {
    return "Windows error " + std::to_string(code);
  }
  std::wstring message(buffer, length);
  LocalFree(buffer);
  while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' ||
                              message.back() == L' ')) {
    message.pop_back();
  }
  return ToUtf8(message);
}

std::runtime_error WindowsError(const std::string& action, const fs::path& path, DWORD code) {
  return std::runtime_error(action + " " + ToUtf8(path.wstring()) + ": " +
                            WindowsErrorMessage(code));
}

bool PathEntryExists(const fs::path& path) {
  return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

DWORD ReadAttributes(const fs::path& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    throw WindowsError("Unable to read attributes for", path, GetLastError());
  }
  return attributes;
}

DWORD CloneableAttributes(DWORD attributes) {
  constexpr DWORD mask = FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_HIDDEN |
                         FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | FILE_ATTRIBUTE_READONLY |
                         FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_TEMPORARY;
  const DWORD cloneable = attributes & mask;
  return cloneable == 0 ? FILE_ATTRIBUTE_NORMAL : cloneable;
}

Handle OpenPath(const fs::path& path, DWORD access, DWORD share, DWORD disposition,
                DWORD flags) {
  Handle handle(CreateFileW(path.c_str(), access, share, nullptr, disposition, flags, nullptr));
  if (!handle.valid()) {
    throw WindowsError("Unable to open", path, GetLastError());
  }
  return handle;
}

VolumeInfo ReadVolumeInfo(const fs::path& path) {
  std::array<wchar_t, 1024> root{};
  if (!GetVolumePathNameW(path.c_str(), root.data(), static_cast<DWORD>(root.size()))) {
    throw WindowsError("Unable to resolve volume for", path, GetLastError());
  }

  std::array<wchar_t, 1024> volumeName{};
  if (!GetVolumeNameForVolumeMountPointW(root.data(), volumeName.data(),
                                         static_cast<DWORD>(volumeName.size()))) {
    throw WindowsError("Unable to resolve volume identity for", path, GetLastError());
  }

  std::array<wchar_t, 64> filesystem{};
  DWORD serial = 0;
  DWORD maximumComponentLength = 0;
  DWORD filesystemFlags = 0;
  if (!GetVolumeInformationW(root.data(), nullptr, 0, &serial, &maximumComponentLength,
                             &filesystemFlags, filesystem.data(),
                             static_cast<DWORD>(filesystem.size()))) {
    throw WindowsError("Unable to read filesystem for", path, GetLastError());
  }

  DWORD sectorsPerCluster = 0;
  DWORD bytesPerSector = 0;
  DWORD freeClusters = 0;
  DWORD totalClusters = 0;
  if (!GetDiskFreeSpaceW(root.data(), &sectorsPerCluster, &bytesPerSector, &freeClusters,
                         &totalClusters)) {
    throw WindowsError("Unable to read cluster size for", path, GetLastError());
  }
  return {volumeName.data(), filesystem.data(),
          static_cast<std::int64_t>(sectorsPerCluster) * bytesPerSector};
}

bool TryGetBlockCloneVolume(const fs::path& source, const fs::path& target,
                            VolumeInfo& sourceVolume) {
  if (!PathEntryExists(source) || !PathEntryExists(target)) {
    return false;
  }
  sourceVolume = ReadVolumeInfo(source);
  const VolumeInfo targetVolume = ReadVolumeInfo(target);
  return _wcsicmp(sourceVolume.name.c_str(), targetVolume.name.c_str()) == 0 &&
         _wcsicmp(sourceVolume.filesystem.c_str(), L"ReFS") == 0 &&
         _wcsicmp(targetVolume.filesystem.c_str(), L"ReFS") == 0;
}

fs::path BuildTemporaryPath(const fs::path& target) {
  GUID id{};
  if (FAILED(CoCreateGuid(&id))) {
    throw std::runtime_error("Unable to allocate a temporary clone path");
  }
  std::array<wchar_t, 40> raw{};
  StringFromGUID2(id, raw.data(), static_cast<int>(raw.size()));
  std::wstring suffix;
  for (const wchar_t character : raw) {
    if (character == L'\0') {
      break;
    }
    if (character != L'{' && character != L'}' && character != L'-') {
      suffix.push_back(character);
    }
  }
  const fs::path parent = fs::absolute(target).parent_path();
  if (parent.empty()) {
    throw std::runtime_error("Target has no parent directory: " + ToUtf8(target.wstring()));
  }
  return parent / (L".orca-refs-clone-" + suffix);
}

void AssertNotReparsePoint(const fs::path& path, DWORD attributes) {
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw CloneUnavailableError("Directory contains a reparse point: " +
                                ToUtf8(path.wstring()));
  }
}

void BuildClonePlan(const fs::path& sourceRoot, const fs::path& relative,
                    ClonePlan& plan) {
  const fs::path sourceDirectory = sourceRoot / relative;
  for (const fs::directory_entry& entry : fs::directory_iterator(sourceDirectory)) {
    const DWORD attributes = ReadAttributes(entry.path());
    AssertNotReparsePoint(entry.path(), attributes);
    const fs::path child = relative / entry.path().filename();
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      plan.directories.push_back(child);
      BuildClonePlan(sourceRoot, child, plan);
    } else {
      plan.files.push_back(child);
    }
  }
}

void SetFileLength(HANDLE file, std::int64_t length, const fs::path& path) {
  LARGE_INTEGER position{};
  position.QuadPart = length;
  if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) || !SetEndOfFile(file)) {
    throw WindowsError("Unable to size", path, GetLastError());
  }
}

void CloneExtent(HANDLE source, HANDLE target, std::int64_t offset, std::int64_t count,
                 const fs::path& targetPath) {
  DUPLICATE_EXTENTS_DATA data{};
  data.FileHandle = source;
  data.SourceFileOffset.QuadPart = offset;
  data.TargetFileOffset.QuadPart = offset;
  data.ByteCount.QuadPart = count;
  DWORD bytesReturned = 0;
  if (!DeviceIoControl(target, FSCTL_DUPLICATE_EXTENTS_TO_FILE, &data, sizeof(data), nullptr, 0,
                       &bytesReturned, nullptr)) {
    const DWORD code = GetLastError();
    throw CloneUnavailableError("ReFS block clone failed for " + ToUtf8(targetPath.wstring()) +
                                ": " + WindowsErrorMessage(code));
  }
}

void MarkSparse(HANDLE target, const fs::path& targetPath) {
  DWORD bytesReturned = 0;
  if (!DeviceIoControl(target, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0, &bytesReturned,
                       nullptr)) {
    const DWORD code = GetLastError();
    throw CloneUnavailableError("Unable to match sparse-file state for " +
                                ToUtf8(targetPath.wstring()) + ": " +
                                WindowsErrorMessage(code));
  }
}

void CopyTail(HANDLE source, HANDLE target, std::int64_t offset, std::int64_t length,
              const fs::path& targetPath) {
  if (length == 0) {
    return;
  }
  LARGE_INTEGER position{};
  position.QuadPart = offset;
  if (!SetFilePointerEx(source, position, nullptr, FILE_BEGIN) ||
      !SetFilePointerEx(target, position, nullptr, FILE_BEGIN)) {
    throw WindowsError("Unable to seek", targetPath, GetLastError());
  }
  std::vector<std::uint8_t> buffer(static_cast<std::size_t>(length));
  DWORD bytesRead = 0;
  if (!ReadFile(source, buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, nullptr) ||
      bytesRead != buffer.size()) {
    throw WindowsError("Unable to read clone tail for", targetPath, GetLastError());
  }
  DWORD bytesWritten = 0;
  if (!WriteFile(target, buffer.data(), bytesRead, &bytesWritten, nullptr) ||
      bytesWritten != bytesRead) {
    throw WindowsError("Unable to write clone tail for", targetPath, GetLastError());
  }
}

void CloneFileData(const fs::path& sourcePath, const fs::path& targetPath,
                   std::int64_t clusterSize) {
  BY_HANDLE_FILE_INFORMATION sourceInfo{};
  LARGE_INTEGER length{};
  {
    Handle source = OpenPath(sourcePath, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING,
                             FILE_FLAG_SEQUENTIAL_SCAN);
    if (!GetFileInformationByHandle(source.get(), &sourceInfo)) {
      throw WindowsError("Unable to inspect", sourcePath, GetLastError());
    }
    AssertNotReparsePoint(sourcePath, sourceInfo.dwFileAttributes);
    if (!GetFileSizeEx(source.get(), &length)) {
      throw WindowsError("Unable to read size for", sourcePath, GetLastError());
    }

    Handle target = OpenPath(targetPath, GENERIC_READ | GENERIC_WRITE, 0, CREATE_NEW,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN);
    if ((sourceInfo.dwFileAttributes & FILE_ATTRIBUTE_SPARSE_FILE) != 0) {
      MarkSparse(target.get(), targetPath);
    }
    SetFileLength(target.get(), length.QuadPart, targetPath);
    const std::int64_t cloneLength = length.QuadPart - (length.QuadPart % clusterSize);
    for (std::int64_t offset = 0; offset < cloneLength; offset += MaxCloneChunk) {
      CloneExtent(source.get(), target.get(), offset,
                  std::min(MaxCloneChunk, cloneLength - offset), targetPath);
    }
    CopyTail(source.get(), target.get(), cloneLength, length.QuadPart - cloneLength, targetPath);
    if (!SetFileTime(target.get(), &sourceInfo.ftCreationTime, &sourceInfo.ftLastAccessTime,
                     &sourceInfo.ftLastWriteTime)) {
      throw WindowsError("Unable to set timestamps on", targetPath, GetLastError());
    }
  }
  if (!SetFileAttributesW(targetPath.c_str(), CloneableAttributes(sourceInfo.dwFileAttributes))) {
    throw WindowsError("Unable to set attributes on", targetPath, GetLastError());
  }
}

void ApplyDirectoryMetadata(const fs::path& sourcePath, const fs::path& targetPath) {
  const DWORD sourceAttributes = ReadAttributes(sourcePath);
  Handle source = OpenPath(sourcePath, FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS);
  Handle target = OpenPath(targetPath, FILE_WRITE_ATTRIBUTES,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING,
                           FILE_FLAG_BACKUP_SEMANTICS);
  FILETIME creation{};
  FILETIME access{};
  FILETIME write{};
  if (!GetFileTime(source.get(), &creation, &access, &write) ||
      !SetFileTime(target.get(), &creation, &access, &write)) {
    throw WindowsError("Unable to copy directory timestamps for", targetPath, GetLastError());
  }
  if (!SetFileAttributesW(targetPath.c_str(),
                          CloneableAttributes(sourceAttributes) | FILE_ATTRIBUTE_DIRECTORY)) {
    throw WindowsError("Unable to set directory attributes on", targetPath, GetLastError());
  }
}

std::size_t ProcessorThreadCount() {
  const DWORD count = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
  return std::max<std::size_t>(1, count == 0 ? std::thread::hardware_concurrency() : count);
}

template <typename Operation>
void RunParallel(std::size_t itemCount, Operation operation) {
  if (itemCount == 0) {
    return;
  }
  const std::size_t workerCount = std::min(itemCount, ProcessorThreadCount());
  std::atomic<std::size_t> next{0};
  std::atomic<bool> stop{false};
  std::mutex failureMutex;
  std::exception_ptr failure;

  const auto worker = [&]() {
    while (!stop.load(std::memory_order_relaxed)) {
      const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
      if (index >= itemCount) {
        return;
      }
      try {
        operation(index);
      } catch (...) {
        {
          std::lock_guard<std::mutex> lock(failureMutex);
          if (!failure) {
            failure = std::current_exception();
          }
        }
        stop.store(true, std::memory_order_relaxed);
      }
    }
  };

  std::vector<std::thread> workers;
  workers.reserve(workerCount - 1);
  for (std::size_t index = 1; index < workerCount; ++index) {
    workers.emplace_back(worker);
  }
  worker();
  for (std::thread& thread : workers) {
    thread.join();
  }
  if (failure) {
    std::rethrow_exception(failure);
  }
}

void CloneFilesParallel(const fs::path& sourceRoot, const fs::path& targetRoot,
                        const std::vector<fs::path>& files, std::int64_t clusterSize) {
  RunParallel(files.size(), [&](std::size_t index) {
    CloneFileData(sourceRoot / files[index], targetRoot / files[index], clusterSize);
  });
}

void ClearReadOnly(const fs::path& root) {
  std::error_code error;
  for (const fs::directory_entry& entry : fs::recursive_directory_iterator(
           root, fs::directory_options::skip_permission_denied, error)) {
    const DWORD attributes = GetFileAttributesW(entry.path().c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_READONLY) != 0) {
      SetFileAttributesW(entry.path().c_str(), attributes & ~FILE_ATTRIBUTE_READONLY);
    }
  }
  const DWORD rootAttributes = GetFileAttributesW(root.c_str());
  if (rootAttributes != INVALID_FILE_ATTRIBUTES &&
      (rootAttributes & FILE_ATTRIBUTE_READONLY) != 0) {
    SetFileAttributesW(root.c_str(), rootAttributes & ~FILE_ATTRIBUTE_READONLY);
  }
}

void DeleteTemporaryPath(const fs::path& path) {
  std::error_code error;
  if (!fs::exists(path, error)) {
    return;
  }
  ClearReadOnly(path);
  fs::remove_all(path, error);
}

void PublishTemporaryPath(const fs::path& temporary, const fs::path& target) {
  if (MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) {
    return;
  }
  if (PathEntryExists(target)) {
    throw TargetExistsError("Target already exists: " + ToUtf8(target.wstring()));
  }
  throw WindowsError("Unable to publish", target, GetLastError());
}

void CloneDirectoryAtomically(const fs::path& source, const fs::path& target,
                              std::int64_t clusterSize) {
  ClonePlan plan;
  BuildClonePlan(source, {}, plan);
  const fs::path temporary = BuildTemporaryPath(target);
  try {
    if (!fs::create_directory(temporary)) {
      throw TargetExistsError("Target already exists: " + ToUtf8(temporary.wstring()));
    }
    for (std::size_t index = 1; index < plan.directories.size(); ++index) {
      fs::create_directory(temporary / plan.directories[index]);
    }
    CloneFilesParallel(source, temporary, plan.files, clusterSize);
    RunParallel(plan.directories.size(), [&](std::size_t index) {
      ApplyDirectoryMetadata(source / plan.directories[index],
                             temporary / plan.directories[index]);
    });
    PublishTemporaryPath(temporary, target);
  } catch (...) {
    DeleteTemporaryPath(temporary);
    throw;
  }
}

void CloneFileAtomically(const fs::path& source, const fs::path& target,
                         std::int64_t clusterSize) {
  const fs::path temporary = BuildTemporaryPath(target);
  try {
    CloneFileData(source, temporary, clusterSize);
    PublishTemporaryPath(temporary, target);
  } catch (...) {
    DeleteTemporaryPath(temporary);
    throw;
  }
}

void ClonePath(const fs::path& source, const fs::path& target, std::int64_t clusterSize) {
  if (PathEntryExists(target)) {
    throw TargetExistsError("Target already exists: " + ToUtf8(target.wstring()));
  }
  const DWORD sourceAttributes = ReadAttributes(source);
  AssertNotReparsePoint(source, sourceAttributes);
  if ((sourceAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    CloneDirectoryAtomically(source, target, clusterSize);
  } else {
    CloneFileAtomically(source, target, clusterSize);
  }
}

}

int wmain(int argc, wchar_t* argv[]) {
  if (argc != 4 || (wcscmp(argv[1], L"probe") != 0 && wcscmp(argv[1], L"clone") != 0)) {
    std::cerr << "Usage: orca-block-clone.exe <probe|clone> <source> <target>\n";
    return ExitFailure;
  }

  try {
    const fs::path source = fs::absolute(argv[2]);
    const fs::path target = fs::absolute(argv[3]);
    const fs::path targetProbe = wcscmp(argv[1], L"clone") == 0 ? target.parent_path() : target;
    VolumeInfo sourceVolume;
    if (targetProbe.empty() || !TryGetBlockCloneVolume(source, targetProbe, sourceVolume)) {
      std::cerr << "Source and target must be on the same ReFS volume.\n";
      return ExitUnavailable;
    }
    if (wcscmp(argv[1], L"probe") == 0) {
      return 0;
    }
    ClonePath(source, target, sourceVolume.clusterSize);
    return 0;
  } catch (const TargetExistsError& error) {
    std::cerr << error.what() << '\n';
    return ExitTargetExists;
  } catch (const CloneUnavailableError& error) {
    std::cerr << error.what() << '\n';
    return ExitUnavailable;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return ExitFailure;
  }
}
