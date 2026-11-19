#include <node_api.h>
#include <sys/sysctl.h>

// kern.memorystatus_level is the kernel's free-memory percentage, the value
// `memory_pressure -Q` prints, read here without spawning a process.
static napi_value freePercent(napi_env env, napi_callback_info info) {
  (void)info;
  int level = -1;
  size_t size = sizeof(level);
  napi_value result;
  if (sysctlbyname("kern.memorystatus_level", &level, &size, NULL, 0) != 0 || level < 0 ||
      level > 100) {
    napi_get_null(env, &result);
    return result;
  }
  napi_create_int32(env, level, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "freePercent", NAPI_AUTO_LENGTH, freePercent, NULL, &function);
  napi_set_named_property(env, exports, "freePercent", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
