#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static BOOL (*originalPerformKeyEquivalent)(id, SEL, NSEvent *);

static BOOL performKeyEquivalent(id receiver, SEL selector, NSEvent *event) {
  // AppKit's numeric-pad path indexes an empty dead-key string on macOS 27.
  if (event.type == NSEventTypeKeyDown &&
      (event.modifierFlags & NSEventModifierFlagNumericPad) != 0 &&
      event.charactersIgnoringModifiers.length == 0) {
    return NO;
  }
  return originalPerformKeyEquivalent(receiver, selector, event);
}

bool configureMenuDeadKeyGuard(void) {
  if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion < 27) return true;
  if (originalPerformKeyEquivalent != NULL) return true;
  if (!NSThread.isMainThread) return false;
  Method method = class_getInstanceMethod(NSMenu.class, @selector(performKeyEquivalent:));
  if (method == NULL || method_getNumberOfArguments(method) != 3) return false;
  char *returnType = method_copyReturnType(method);
  bool returnsBool = strcmp(returnType, @encode(BOOL)) == 0;
  free(returnType);
  if (!returnsBool) return false;
  originalPerformKeyEquivalent = (BOOL (*)(id, SEL, NSEvent *))method_getImplementation(method);
  method_setImplementation(method, (IMP)performKeyEquivalent);
  return true;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, configureMenuDeadKeyGuard(), &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, NULL, &function);
  napi_set_named_property(env, exports, "configure", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
