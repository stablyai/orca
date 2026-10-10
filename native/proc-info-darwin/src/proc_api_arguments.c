#include "proc_api_arguments.h"

#include <math.h>
#include <string.h>

int read_process_pid_argument(napi_env env, napi_callback_info info, int32_t *pid) {
  size_t argc = 1;
  napi_value argv[1];
  double value;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_double(env, argv[0], &value) != napi_ok || !isfinite(value) ||
      value < 1 || value > INT32_MAX || floor(value) != value) {
    napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a positive pid");
    return 0;
  }
  *pid = (int32_t)value;
  return 1;
}

int read_process_tty_argument(napi_env env, napi_callback_info info, char *out, size_t size) {
  size_t argc = 2;
  napi_value argv[2];
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
      napi_get_value_string_utf8(env, argv[1], NULL, 0, &length) != napi_ok ||
      length == 0 || length >= size ||
      napi_get_value_string_utf8(env, argv[1], out, size, &length) != napi_ok ||
      strlen(out) != length) {
    goto invalid;
  }
  const char *name = strncmp(out, "/dev/", 5) == 0 ? out + 5 : out;
  if (*name == '\0' || strchr(name, '/') != NULL || strchr(name, '\\') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    goto invalid;
  }
  memmove(out, name, strlen(name) + 1);
  return 1;

invalid:
  napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a terminal name");
  return 0;
}
