#define NAPI_VERSION 8
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

/* Candidate primitive: pathname continuity and legacy-owner exclusion are caller gates. */
typedef struct {
  void *path;
  bool release_unverifiable;
#ifdef _WIN32
  HANDLE handle;
#else
  int fd;
#endif
} profile_lock;

static const napi_type_tag lock_tag = {
  UINT64_C(0x4828d1303e9f4925), UINT64_C(0x88bb7d60f52fcbb3)
};

static napi_value fail(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static bool close_lock(profile_lock *lock) {
  if (lock->release_unverifiable) return false;
#ifdef _WIN32
  if (lock->handle != INVALID_HANDLE_VALUE) {
    HANDLE handle = lock->handle;
    lock->handle = INVALID_HANDLE_VALUE;
    lock->release_unverifiable = CloseHandle(handle) == 0;
  }
#else
  if (lock->fd >= 0) {
    /* Never retry close: an interrupted close may already have released the fd. */
    int fd = lock->fd;
    lock->fd = -1;
    lock->release_unverifiable = close(fd) != 0;
  }
#endif
  return !lock->release_unverifiable;
}

static void finalize_lock(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  profile_lock *lock = data;
  close_lock(lock);
  free(lock->path);
  free(lock);
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 1 || napi_typeof(env, args[0], &type) != napi_ok ||
      type != napi_string) {
    return fail(env, "profile_lock_unavailable", "Expected one lock path string");
  }

  profile_lock *lock = calloc(1, sizeof(*lock));
  if (!lock) return fail(env, "profile_lock_unavailable", "Cannot allocate lock");
#ifdef _WIN32
  lock->handle = INVALID_HANDLE_VALUE;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, args[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32766) {
    free(lock);
    return fail(env, "profile_lock_unavailable", "Invalid lock path");
  }
  char16_t *path = calloc(length + 1, sizeof(*path));
  if (!path) {
    free(lock);
    return fail(env, "profile_lock_unavailable", "Cannot allocate lock path");
  }
  size_t copied = 0;
  bool valid = napi_get_value_string_utf16(env, args[0], path, length + 1,
                                         &copied) == napi_ok && copied == length;
  for (size_t i = 0; i < length; i++) if (path[i] == 0) valid = false;
  if (!valid) {
    free(path);
    free(lock);
    return fail(env, "profile_lock_unavailable", "Invalid lock path");
  }
  lock->handle = CreateFileW((const WCHAR *)path, GENERIC_READ | GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
                            FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  lock->path = path;
  if (lock->handle == INVALID_HANDLE_VALUE) {
    finalize_lock(env, lock, NULL);
    return fail(env, "profile_lock_unavailable", "Cannot open lock file");
  }
  BY_HANDLE_FILE_INFORMATION file;
  if (!GetFileInformationByHandle(lock->handle, &file) ||
      GetFileType(lock->handle) != FILE_TYPE_DISK ||
      (file.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    finalize_lock(env, lock, NULL);
    return fail(env, "profile_lock_unavailable", "Lock path is not a regular file");
  }
  OVERLAPPED offset = {0};
  if (!LockFileEx(lock->handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                  0, 1, 0, &offset)) {
    DWORD error = GetLastError();
    finalize_lock(env, lock, NULL);
    return fail(env, error == ERROR_LOCK_VIOLATION ? "profile_lock_busy" :
                "profile_lock_unavailable", "Cannot acquire profile lock");
  }
#else
  lock->fd = -1;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length == SIZE_MAX) {
    free(lock);
    return fail(env, "profile_lock_unavailable", "Invalid lock path");
  }
  char *path = malloc(length + 1);
  if (!path) {
    free(lock);
    return fail(env, "profile_lock_unavailable", "Cannot allocate lock path");
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, args[0], path, length + 1, &copied) != napi_ok ||
      copied != length || memchr(path, 0, length) != NULL) {
    free(path);
    free(lock);
    return fail(env, "profile_lock_unavailable", "Invalid lock path");
  }
  /* O_NONBLOCK also prevents a hostile FIFO from blocking before fstat. */
  lock->fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  lock->path = path;
  if (lock->fd < 0) {
    finalize_lock(env, lock, NULL);
    return fail(env, "profile_lock_unavailable", "Cannot open lock file");
  }
  struct stat file;
  if (fstat(lock->fd, &file) != 0 || !S_ISREG(file.st_mode)) {
    finalize_lock(env, lock, NULL);
    return fail(env, "profile_lock_unavailable", "Lock path is not a regular file");
  }
  if (flock(lock->fd, LOCK_EX | LOCK_NB) != 0) {
    int error = errno;
    finalize_lock(env, lock, NULL);
    return fail(env, error == EWOULDBLOCK || error == EAGAIN ? "profile_lock_busy" :
                "profile_lock_unavailable", "Cannot acquire profile lock");
  }
#endif

  napi_value token;
  if (napi_create_object(env, &token) != napi_ok ||
      napi_type_tag_object(env, token, &lock_tag) != napi_ok ||
      napi_wrap(env, token, lock, finalize_lock, NULL, NULL) != napi_ok) {
    finalize_lock(env, lock, NULL);
    return fail(env, "profile_lock_unavailable", "Cannot create lock token");
  }
  return token;
}

static profile_lock *get_lock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  bool tagged = false;
  napi_valuetype type;
  profile_lock *lock = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 1 ||
      napi_typeof(env, args[0], &type) != napi_ok || type != napi_object ||
      napi_check_object_type_tag(env, args[0], &lock_tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, args[0], (void **)&lock) != napi_ok || !lock) {
    fail(env, "profile_lock_unavailable", "Expected a profile lock token");
    return NULL;
  }
  return lock;
}

static napi_value assert_current(napi_env env, napi_callback_info info) {
  profile_lock *lock = get_lock(env, info);
  if (!lock) return NULL;
  if (lock->release_unverifiable) {
    return fail(env, "profile_lock_release_unverifiable", "Cannot verify profile lock release");
  }
#ifdef _WIN32
  if (lock->handle == INVALID_HANDLE_VALUE) {
    return fail(env, "profile_lock_released", "Profile lock was released");
  }
  BY_HANDLE_FILE_INFORMATION held, current;
  if (!GetFileInformationByHandle(lock->handle, &held)) {
    return fail(env, "profile_lock_unavailable", "Cannot inspect retained lock");
  }
  HANDLE path_handle = CreateFileW((const WCHAR *)lock->path, FILE_READ_ATTRIBUTES,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (path_handle == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    return fail(env, error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ?
                "profile_lock_identity_changed" : "profile_lock_unavailable",
                "Cannot inspect current lock path");
  }
  bool inspected = GetFileInformationByHandle(path_handle, &current) != 0;
  DWORD file_type = GetFileType(path_handle);
  CloseHandle(path_handle);
  if (!inspected) {
    return fail(env, "profile_lock_unavailable", "Cannot inspect current lock file");
  }
  if (file_type != FILE_TYPE_DISK ||
      (current.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      held.dwVolumeSerialNumber != current.dwVolumeSerialNumber ||
      held.nFileIndexHigh != current.nFileIndexHigh ||
      held.nFileIndexLow != current.nFileIndexLow) {
    return fail(env, "profile_lock_identity_changed", "Profile lock path identity changed");
  }
#else
  if (lock->fd < 0) {
    return fail(env, "profile_lock_released", "Profile lock was released");
  }
  struct stat held, current;
  if (fstat(lock->fd, &held) != 0) {
    return fail(env, "profile_lock_unavailable", "Cannot inspect retained lock");
  }
  if (lstat((const char *)lock->path, &current) != 0) {
    int error = errno;
    return fail(env, error == ENOENT || error == ENOTDIR ?
                "profile_lock_identity_changed" : "profile_lock_unavailable",
                "Cannot inspect current lock path");
  }
  if (!S_ISREG(current.st_mode) || !S_ISREG(held.st_mode) ||
      held.st_dev != current.st_dev || held.st_ino != current.st_ino) {
    return fail(env, "profile_lock_identity_changed", "Profile lock path identity changed");
  }
#endif
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}

static napi_value release(napi_env env, napi_callback_info info) {
  profile_lock *lock = get_lock(env, info);
  if (!lock) return NULL;
  if (!close_lock(lock)) {
    return fail(env, "profile_lock_release_unverifiable", "Cannot verify profile lock release");
  }
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL},
    {"assertCurrent", NULL, assert_current, NULL, NULL, NULL, napi_default, NULL},
    {"release", NULL, release, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) {
    return fail(env, "profile_lock_unavailable", "Cannot initialize profile lock");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
