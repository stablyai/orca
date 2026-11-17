#import <AppKit/AppKit.h>
#import <dlfcn.h>

@interface MenuTarget : NSObject
@property NSInteger copies;
- (void)copy:(id)sender;
@end

@implementation MenuTarget
- (void)copy:(id)sender { self.copies++; }
@end

static NSEvent *key(NSString *characters, NSEventModifierFlags flags, unsigned short code) {
  return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags
                       timestamp:0 windowNumber:0 context:nil characters:characters
     charactersIgnoringModifiers:characters isARepeat:NO keyCode:code];
}

int main(int argc, char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Probe"];
    menu.autoenablesItems = NO;
    MenuTarget *target = [MenuTarget new];
    NSMenuItem *copy = [menu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    copy.target = target;
    copy.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    NSEvent *dead = key(@"", NSEventModifierFlagNumericPad, 33);
    if (argc == 1) {
      @try {
        [menu performKeyEquivalent:dead];
      } @catch (NSException *exception) {
        fprintf(stderr, "%s: %s\n", exception.name.UTF8String, exception.reason.UTF8String);
        return 42;
      }
      return 1;
    }
    void *addon = dlopen(argv[1], RTLD_LAZY | RTLD_LOCAL);
    if (!addon) return 2;
    bool (*configure)(void) = dlsym(addon, "configureMenuDeadKeyGuard");
    if (!configure || !configure() || !configure()) return 3;
    if ([menu performKeyEquivalent:dead]) return 4;
    if ([menu performKeyEquivalent:key(@"", NSEventModifierFlagNumericPad | NSEventModifierFlagCommand, 33)]) return 5;
    if (![menu performKeyEquivalent:key(@"c", NSEventModifierFlagCommand, 8)] || target.copies != 1) return 6;
    NSMenuItem *digit = [menu addItemWithTitle:@"Digit" action:@selector(copy:) keyEquivalent:@"1"];
    digit.target = target;
    digit.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    if (![menu performKeyEquivalent:key(@"1", NSEventModifierFlagNumericPad | NSEventModifierFlagCommand, 83)] || target.copies != 2) return 7;
    puts("dead keys passed through; Command+C and keypad shortcut delivered");
  }
  return 0;
}
