/* Holds the standard SQLite main-file lock without opening or modifying SQLite. */
#ifdef _WIN32
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
int wmain(int argc, wchar_t **argv) {
  if (argc != 2 && argc != 3) return 2;
  int check = argc == 3 && wcscmp(argv[2], L"--check") == 0;
  if (argc == 3 && !check) return 2;
  HANDLE file = CreateFileW(argv[1], check ? FILE_READ_ATTRIBUTES : GENERIC_READ | DELETE,
                           check ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return 3;
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
  while (getchar() != EOF) {}
  return CloseHandle(file) ? 0 : 5;
}
#else
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/mount.h>
#else
#include <sys/vfs.h>
#endif
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
  while (getchar() != EOF) {}
  return close(fd) == 0 ? 0 : 5;
}
#endif
