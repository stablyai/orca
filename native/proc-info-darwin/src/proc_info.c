// Verify a known PTY before reporting the process group that receives resize signals.
#define NAPI_VERSION 8
#include <node_api.h>
#include "proc_api_arguments.h"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>

#define CHECK(call) do { if ((call) != napi_ok) return NULL; } while (0)

static napi_value syscall_error(napi_env env, const char *operation) {
  char message[160];
  snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
  napi_throw_error(env, "ORCA_PROC_INFO_SYSCALL", message);
  return NULL;
}

static napi_status set_int(napi_env env, napi_value object, const char *name, int32_t value) {
  napi_value number;
  napi_status status = napi_create_int32(env, value, &number);
  return status == napi_ok ? napi_set_named_property(env, object, name, number) : status;
}

static napi_value ReadProcessForegroundGroup(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  char tty[NAME_MAX + 1];
  if (!read_process_pid_argument(env, info, &pid) ||
      !read_process_tty_argument(env, info, tty, sizeof(tty))) {
    return NULL;
  }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc proc = {0};
  size_t size = sizeof(proc);
  if (sysctl(mib, 4, &proc, &size, NULL, 0) != 0) {
    return syscall_error(env, "sysctl(KERN_PROC_PID) failed");
  }
  if (size == 0) {
    napi_value result;
    CHECK(napi_get_null(env, &result));
    return result;
  }
  if (size != sizeof(proc) || proc.kp_proc.p_pid != pid) {
    napi_throw_error(env, "ORCA_PROC_INFO_RESPONSE", "unexpected process metadata");
    return NULL;
  }
  char path[sizeof("/dev/") + sizeof(tty)];
  snprintf(path, sizeof(path), "/dev/%s", tty);
  struct stat device;
  // Only a direct devfs character device can identify a pane's known PTY.
  if (proc.kp_eproc.e_tdev == NODEV || lstat(path, &device) != 0 ||
      !S_ISCHR(device.st_mode) || device.st_rdev != proc.kp_eproc.e_tdev) {
    strlcpy(tty, "??", sizeof(tty));
  }
  napi_value row;
  napi_value tty_value;
  CHECK(napi_create_object(env, &row));
  CHECK(set_int(env, row, "pid", proc.kp_proc.p_pid));
  CHECK(set_int(env, row, "tpgid", proc.kp_eproc.e_tpgid));
  CHECK(napi_create_string_utf8(env, tty, NAPI_AUTO_LENGTH, &tty_value));
  CHECK(napi_set_named_property(env, row, "tty", tty_value));
  return row;
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  napi_property_descriptor property = {
      "readProcessForegroundGroup", NULL, ReadProcessForegroundGroup, NULL, NULL, NULL,
      napi_enumerable, NULL};
  CHECK(napi_define_properties(env, exports, 1, &property));
  return exports;
}
