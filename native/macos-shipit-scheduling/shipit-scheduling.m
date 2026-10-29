#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <node_api.h>

// Electron does not expose Squirrel's launchd job configuration to JavaScript.
@interface NSObject (OrcaShipItSignal)
- (id)map:(id (^)(id))transform;
@end

static id (*originalJobDictionary)(id, SEL);

static id interactiveJobDictionary(id receiver, SEL selector) {
  id signal = originalJobDictionary(receiver, selector);
  @try {
    if (![signal respondsToSelector:@selector(map:)]) return signal;
    return [signal map:^id(id job) {
      @try {
        if (![job isKindOfClass:NSDictionary.class]) return job;
        NSMutableDictionary *interactiveJob = [job mutableCopy];
        // A user-requested install must not inherit launchd's daemon I/O throttling.
        interactiveJob[@"ProcessType"] = @"Interactive";
        return interactiveJob;
      } @catch (id exception) {
        return job;
      }
    }];
  } @catch (id exception) {
    return signal;
  }
}

bool configureShipItScheduling(void) {
  if (originalJobDictionary != NULL) return true;
  Class launcher = NSClassFromString(@"SQRLShipItLauncher");
  Method method = class_getClassMethod(launcher, NSSelectorFromString(@"shipItJobDictionary"));
  if (method == NULL || method_getNumberOfArguments(method) != 2) return false;
  char *returnType = method_copyReturnType(method);
  bool returnsObject = strcmp(returnType, @encode(id)) == 0;
  free(returnType);
  if (!returnsObject) return false;
  originalJobDictionary = (id (*)(id, SEL))method_getImplementation(method);
  method_setImplementation(method, (IMP)interactiveJobDictionary);
  return true;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, configureShipItScheduling(), &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, NULL, &function);
  napi_set_named_property(env, exports, "configure", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
