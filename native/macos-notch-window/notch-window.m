#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <stdint.h>
#include <string.h>

static bool preventPanelActivation(NSWindow *window) {
  if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion < 27) return true;
  // Electron #53889: the nonactivating style alone does not prevent app activation on macOS 27.
  SEL selector = NSSelectorFromString(@"_setPreventsActivation:");
  if (![window respondsToSelector:selector]) return false;
  Method method = class_getInstanceMethod(window.class, selector);
  if (method == NULL || method_getNumberOfArguments(method) != 3) return false;
  char *returnType = method_copyReturnType(method);
  char *argumentType = method_copyArgumentType(method, 2);
  bool supported = strcmp(returnType, @encode(void)) == 0 &&
                   strcmp(argumentType, @encode(BOOL)) == 0;
  free(returnType);
  free(argumentType);
  if (!supported) return false;
  void (*setPreventsActivation)(id, SEL, BOOL) =
      (void (*)(id, SEL, BOOL))method_getImplementation(method);
  @try {
    setPreventsActivation(window, selector, YES);
    return true;
  } @catch (NSException *exception) {
    return false;
  }
}

static napi_value configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  bool configured = false;
  bool isBuffer = false;
  void *bytes = NULL;
  size_t length = 0;
  if ([NSThread isMainThread] &&
      napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) == napi_ok && argc == 1 &&
      napi_is_buffer(env, argument, &isBuffer) == napi_ok && isBuffer &&
      napi_get_buffer_info(env, argument, &bytes, &length) == napi_ok &&
      length == sizeof(uintptr_t)) {
    uintptr_t viewAddress = 0;
    memcpy(&viewAddress, bytes, sizeof(viewAddress));
    // Match a live content view without dereferencing an untrusted or stale handle.
    for (NSWindow *window in NSApp.windows) {
      if (viewAddress == 0 ||
          (uintptr_t)(__bridge void *)window.contentView != viewAddress) continue;
      window.canHide = NO;
      window.hidesOnDeactivate = NO;
      configured = !window.canHide && !window.hidesOnDeactivate && preventPanelActivation(window);
      break;
    }
  }
  napi_value result;
  napi_get_boolean(env, configured, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, NULL, &function);
  napi_set_named_property(env, exports, "configure", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
