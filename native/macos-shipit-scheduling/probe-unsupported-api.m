#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>

@interface OrcaSchedulingProbeSignal : NSObject
@property id payload;
@property BOOL throwsOnMap;
@property BOOL throwsObject;
- (id)map:(id (^)(id))transform;
@end

@implementation OrcaSchedulingProbeSignal
- (id)map:(id (^)(id))transform {
  if (self.throwsObject) @throw @"Unsupported map contract";
  if (self.throwsOnMap) {
    [NSException raise:NSInvalidArgumentException format:@"Unsupported map contract"];
  }
  return transform(self.payload);
}
@end

static id originalResult;
static id returnOriginalResult(id receiver, SEL selector) { return originalResult; }

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3) return 1;
    NSString *mode = [NSString stringWithUTF8String:argv[2]];
    Class launcher = objc_allocateClassPair(NSObject.class, "SQRLShipItLauncher", 0);
    SEL selector = NSSelectorFromString(@"shipItJobDictionary");
    const char *encoding = [mode isEqual:@"return-type"] ? "i@:" : "@@:";
    class_addMethod(object_getClass(launcher), selector, (IMP)returnOriginalResult, encoding);
    objc_registerClassPair(launcher);
    void *addon = dlopen(argv[1], RTLD_LAZY | RTLD_LOCAL);
    if (!addon) return 2;
    bool (*configure)(void) = dlsym(addon, "configureShipItScheduling");
    if (!configure) return 3;
    if ([mode isEqual:@"return-type"]) return configure() ? 4 : 0;
    if (!configure() || !configure()) return 5;

    id expected;
    if ([mode isEqual:@"object"]) {
      expected = originalResult = @{@"Label": @"unchanged"};
    } else {
      OrcaSchedulingProbeSignal *signal = [OrcaSchedulingProbeSignal new];
      signal.payload = [mode isEqual:@"payload"] ? @"unsupported" : @{@"Label": @"unchanged"};
      signal.throwsOnMap = [mode isEqual:@"exception"];
      signal.throwsObject = [mode isEqual:@"thrown-object"];
      originalResult = signal;
      if (signal.throwsOnMap || signal.throwsObject) expected = signal;
      else if ([mode isEqual:@"payload"]) expected = signal.payload;
      else expected = @{@"Label": @"unchanged", @"ProcessType": @"Interactive"};
    }
    id (*invoke)(id, SEL) = (id (*)(id, SEL))[launcher methodForSelector:selector];
    id actual = invoke(launcher, selector);
    if (![actual isEqual:expected]) return 6;
    if ([originalResult isKindOfClass:OrcaSchedulingProbeSignal.class] &&
        ![mode isEqual:@"payload"] &&
        ![((OrcaSchedulingProbeSignal *)originalResult).payload isEqual:@{@"Label": @"unchanged"}]) {
      return 7;
    }
  }
  return 0;
}
