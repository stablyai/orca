#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <objc/runtime.h>

static NSMutableArray<NSValue *> *recordedCursorRects = nil;

@interface RenderWidgetHostViewCocoa : NSView
@property(nonatomic, assign) BOOL mouseEventDidResetCursor;
- (BOOL)shouldChangeCurrentCursor;
- (void)mouseEvent:(NSEvent *)theEvent;
@end

@implementation RenderWidgetHostViewCocoa
- (void)addCursorRect:(NSRect)rect cursor:(NSCursor *)cursor {
  (void)cursor;
  if (recordedCursorRects != nil) {
    [recordedCursorRects addObject:[NSValue valueWithRect:rect]];
  }
  [super addCursorRect:rect cursor:cursor];
}
- (BOOL)shouldChangeCurrentCursor {
  return YES;
}
- (void)mouseEvent:(NSEvent *)theEvent {
  if (theEvent.type == NSEventTypeMouseExited) {
    self.mouseEventDidResetCursor = YES;
    [[NSCursor arrowCursor] set];
  } else {
    [[NSCursor pointingHandCursor] set];
  }
}
@end

@interface NativeWidgetMacNSWindow : NSWindow
@property(nonatomic, strong) NSCursor *delegateCursor;
@end

@implementation NativeWidgetMacNSWindow
- (void)cursorUpdate:(NSEvent *)event {
  if (self.delegateCursor != nil) {
    [self.delegateCursor set];
    return;
  }
  [super cursorUpdate:event];
}
@end

@interface SyntheticLocationEvent : NSObject
@property(nonatomic, assign) NSPoint locationInWindow;
@property(nonatomic, assign) NSEventType type;
@end

@implementation SyntheticLocationEvent
@end

static NSEvent *exitEventAt(NSWindow *window, NSPoint point, NSInteger number) {
  return [NSEvent enterExitEventWithType:NSEventTypeMouseExited
                                location:point
                           modifierFlags:0
                               timestamp:0
                            windowNumber:window.windowNumber
                                 context:nil
                             eventNumber:number
                          trackingNumber:1
                                userData:NULL];
}

static BOOL anyRectContainsPoint(NSArray<NSValue *> *rects, NSPoint point) {
  for (NSValue *val in rects) {
    if (NSPointInRect(point, val.rectValue)) {
      return YES;
    }
  }
  return NO;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    if (NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) {
      [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    }

    NativeWidgetMacNSWindow *window = [[NativeWidgetMacNSWindow alloc]
        initWithContentRect:NSMakeRect(200, 200, 800, 600)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                             NSWindowStyleMaskFullSizeContentView)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    RenderWidgetHostViewCocoa *view =
        [[RenderWidgetHostViewCocoa alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)];
    [window setContentView:view];
    recordedCursorRects = [NSMutableArray array];

    if (argc == 1) {
      if (![view shouldChangeCurrentCursor]) return 2;
      [[NSCursor resizeLeftRightCursor] set];
      [view mouseEvent:exitEventAt(window, NSMakePoint(-1, 300), 1)];
      if (![NSCursor.currentCursor isEqual:NSCursor.arrowCursor]) return 3;
      puts("unguarded baseline clobbered resize cursor");
      return 42;
    }

    void *addon = dlopen(argv[1], RTLD_LAZY | RTLD_LOCAL);
    if (!addon) return 4;
    bool (*configure)(void) = dlsym(addon, "configureWindowResizeGuard");
    if (!configure || !configure() || !configure()) return 5;

    // 1. Interior addCursorRect clips perimeter edges & corners while preserving center rects.
    [recordedCursorRects removeAllObjects];
    [view addCursorRect:view.visibleRect cursor:NSCursor.pointingHandCursor];
    if (recordedCursorRects.count == 0) return 6;
    if (anyRectContainsPoint(recordedCursorRects, NSMakePoint(1, 300))) return 7;
    if (anyRectContainsPoint(recordedCursorRects, NSMakePoint(798, 300))) return 8;
    if (anyRectContainsPoint(recordedCursorRects, NSMakePoint(400, 598))) return 9;
    if (anyRectContainsPoint(recordedCursorRects, NSMakePoint(6, 594))) return 10;
    if (!anyRectContainsPoint(recordedCursorRects, NSMakePoint(200, 300))) return 11;

    // 2. Exiting into the outer resize edge (-1, 300) keeps the active resize cursor intact.
    [[NSCursor resizeLeftRightCursor] set];
    [view mouseEvent:exitEventAt(window, NSMakePoint(-1, 300), 2)];
    if (!view.mouseEventDidResetCursor) return 12;
    if (![NSCursor.currentCursor isEqual:NSCursor.resizeLeftRightCursor]) return 13;

    // 3. Exiting well outside the resize zone (-20, 300) still resets the cursor to arrowCursor.
    [view mouseEvent:exitEventAt(window, NSMakePoint(-20, 300), 3)];
    if (![NSCursor.currentCursor isEqual:NSCursor.arrowCursor]) return 14;

    // 4. NativeWidgetMacNSWindow cursorUpdate skips delegate cursor inside resize edges, keeps it inside content.
    window.delegateCursor = NSCursor.pointingHandCursor;
    [[NSCursor resizeLeftRightCursor] set];
    SyntheticLocationEvent *edgeUpdate = [SyntheticLocationEvent new];
    edgeUpdate.type = NSEventTypeCursorUpdate;
    edgeUpdate.locationInWindow = NSMakePoint(1, 300);
    [window cursorUpdate:(NSEvent *)edgeUpdate];
    if ([NSCursor.currentCursor isEqual:NSCursor.pointingHandCursor]) return 15;

    SyntheticLocationEvent *centerUpdate = [SyntheticLocationEvent new];
    centerUpdate.type = NSEventTypeCursorUpdate;
    centerUpdate.locationInWindow = NSMakePoint(200, 300);
    [window cursorUpdate:(NSEvent *)centerUpdate];
    if (![NSCursor.currentCursor isEqual:NSCursor.pointingHandCursor]) return 16;

    puts("window resize guard preserved edge cursors and clipped border cursor rects");
  }
  return 0;
}
