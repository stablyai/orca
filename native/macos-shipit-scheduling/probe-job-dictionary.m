#import <Foundation/Foundation.h>
#import <dlfcn.h>

@interface NSObject (OrcaShipItProbe)
+ (id)shipItJobDictionary;
- (id)subscribeNext:(void (^)(id))next;
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3) return 1;
    NSString *frameworks = [NSString stringWithUTF8String:argv[1]];
    for (NSString *name in @[@"Mantle", @"ReactiveObjC", @"Squirrel"]) {
      NSString *file = [frameworks stringByAppendingFormat:@"/%@.framework/%@", name, name];
      if (!dlopen(file.UTF8String, RTLD_LAZY | RTLD_GLOBAL)) return 2;
    }
    void *addon = dlopen(argv[2], RTLD_LAZY | RTLD_LOCAL);
    if (!addon) return 3;
    bool (*configure)(void) = dlsym(addon, "configureShipItScheduling");
    if (!configure) return 4;
    Class launcher = NSClassFromString(@"SQRLShipItLauncher");
    [[launcher shipItJobDictionary] subscribeNext:^(NSDictionary *before) {
      if (!configure() || !configure()) exit(5);
      [[launcher shipItJobDictionary] subscribeNext:^(NSDictionary *after) {
        NSMutableDictionary *expected = [before mutableCopy];
        expected[@"ProcessType"] = @"Interactive";
        if (![expected isEqual:after]) exit(6);
        NSData *json = [NSJSONSerialization dataWithJSONObject:after options:0 error:nil];
        puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
        exit(0);
      }];
    }];
    [[NSRunLoop mainRunLoop] run];
  }
  return 7;
}
