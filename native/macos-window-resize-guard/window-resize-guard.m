#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static const CGFloat kWindowResizeEdgeGuardInset = 4.0;
static const CGFloat kWindowResizeDefaultCornerInset = 16.0;
static const CGFloat kWindowResizeMinCornerInset = 4.0;
static const CGFloat kWindowResizeMaxCornerInset = 20.0;

static BOOL configured = NO;
static NSInteger cursorSetSuppressDepth = 0;

static SEL resizeDirectionSelector = NULL;
static NSInteger (*windowResizeDirectionFn)(id, SEL, CGPoint) = NULL;

static SEL cornerRadiusSelector = NULL;
static CGFloat (*windowCornerRadiusFn)(id, SEL) = NULL;

static BOOL (*originalShouldChangeCurrentCursor)(id, SEL) = NULL;
static void (*superAddCursorRect)(id, SEL, NSRect, NSCursor *) = NULL;
static void (*originalMouseEvent)(id, SEL, NSEvent *) = NULL;
static void (*originalCursorSet)(id, SEL) = NULL;
static void (*originalNativeWidgetCursorUpdate)(id, SEL, NSEvent *) = NULL;
static void (*superNativeWidgetCursorUpdate)(id, SEL, NSEvent *) = NULL;

static BOOL methodMatchesSignature(Method method, unsigned int expectedArgs, const char *returnType) {
  if (method == NULL || method_getNumberOfArguments(method) != expectedArgs) {
    return NO;
  }
  char *copiedReturnType = method_copyReturnType(method);
  if (copiedReturnType == NULL) {
    return NO;
  }
  BOOL matches = strcmp(copiedReturnType, returnType) == 0;
  free(copiedReturnType);
  return matches;
}

static BOOL argumentTypeMatches(Method method, unsigned int argIndex, const char *expectedType) {
  char *copiedArgType = method_copyArgumentType(method, argIndex);
  if (copiedArgType == NULL) {
    return NO;
  }
  BOOL matches = strcmp(copiedArgType, expectedType) == 0;
  free(copiedArgType);
  return matches;
}

static BOOL isWindowPointInResizeZone(NSWindow *window, NSPoint windowPoint) {
  if (window == nil || windowResizeDirectionFn == NULL) {
    return NO;
  }
  if ((window.styleMask & NSWindowStyleMaskResizable) == 0 ||
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
    return NO;
  }
  if (![window respondsToSelector:resizeDirectionSelector]) {
    return NO;
  }
  return windowResizeDirectionFn(window, resizeDirectionSelector, windowPoint) != -1;
}

static CGFloat resolveWindowCornerInset(NSWindow *window) {
  if (window != nil && windowCornerRadiusFn != NULL && [window respondsToSelector:cornerRadiusSelector]) {
    CGFloat radius = windowCornerRadiusFn(window, cornerRadiusSelector);
    if (radius > kWindowResizeMinCornerInset) {
      return MIN(kWindowResizeMaxCornerInset, radius);
    }
    return kWindowResizeEdgeGuardInset;
  }
  return kWindowResizeDefaultCornerInset;
}

static void addClippedBand(
    NSView *view, SEL selector, NSRect targetRect, NSRect windowBand, NSCursor *cursor) {
  NSRect bandInView = [view convertRect:windowBand fromView:nil];
  NSRect clipped = NSIntersectionRect(targetRect, bandInView);
  if (!NSIsEmptyRect(clipped)) {
    superAddCursorRect(view, selector, clipped, cursor);
  }
}

static BOOL guardedShouldChangeCurrentCursor(id receiver, SEL selector) {
  if (!originalShouldChangeCurrentCursor(receiver, selector)) {
    return NO;
  }
  NSWindow *window = [(NSView *)receiver window];
  if (window != nil) {
    NSPoint windowPoint = [window convertPointFromScreen:NSEvent.mouseLocation];
    if (isWindowPointInResizeZone(window, windowPoint)) {
      return NO;
    }
  }
  return YES;
}

static void guardedAddCursorRect(id receiver, SEL selector, NSRect rect, NSCursor *cursor) {
  NSView *view = (NSView *)receiver;
  NSWindow *window = view.window;
  if (window == nil ||
      (window.styleMask & NSWindowStyleMaskResizable) == 0 ||
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
    superAddCursorRect(receiver, selector, rect, cursor);
    return;
  }

  NSSize windowSize = window.frame.size;
  CGFloat edgeInset = kWindowResizeEdgeGuardInset;
  CGFloat cornerInset = MAX(edgeInset, resolveWindowCornerInset(window));

  // Decompose the window frame excluding the perimeter resize strip and rounded corner targets.
  if (windowSize.width > edgeInset * 2.0 && windowSize.height > cornerInset * 2.0) {
    addClippedBand(
        view,
        selector,
        rect,
        NSMakeRect(edgeInset, cornerInset, windowSize.width - edgeInset * 2.0, windowSize.height - cornerInset * 2.0),
        cursor);
  }
  if (windowSize.width > cornerInset * 2.0 && cornerInset > edgeInset) {
    CGFloat stripWidth = windowSize.width - cornerInset * 2.0;
    CGFloat stripHeight = cornerInset - edgeInset;
    if (windowSize.height >= cornerInset * 2.0) {
      addClippedBand(view, selector, rect, NSMakeRect(cornerInset, edgeInset, stripWidth, stripHeight), cursor);
      addClippedBand(
          view,
          selector,
          rect,
          NSMakeRect(cornerInset, windowSize.height - cornerInset, stripWidth, stripHeight),
          cursor);
    }
  }
}

static void guardedCursorSet(id receiver, SEL selector) {
  // Block Chromium cursor resets only while handling a mouse event inside AppKit's resize border.
  if (cursorSetSuppressDepth > 0 && NSThread.isMainThread) {
    return;
  }
  originalCursorSet(receiver, selector);
}

static void guardedMouseEvent(id receiver, SEL selector, NSEvent *event) {
  NSWindow *window = [(NSView *)receiver window];
  BOOL suppressCursor = NO;
  if (window != nil && event != nil) {
    NSPoint liveWindowPoint = [window convertPointFromScreen:NSEvent.mouseLocation];
    suppressCursor = isWindowPointInResizeZone(window, liveWindowPoint);
    if (!suppressCursor && event.type == NSEventTypeMouseExited && event.window == window) {
      suppressCursor = isWindowPointInResizeZone(window, event.locationInWindow);
    }
  }
  if (!suppressCursor) {
    originalMouseEvent(receiver, selector, event);
    return;
  }
  cursorSetSuppressDepth += 1;
  @try {
    originalMouseEvent(receiver, selector, event);
  } @finally {
    cursorSetSuppressDepth -= 1;
  }
}

static void guardedNativeWidgetCursorUpdate(id receiver, SEL selector, NSEvent *event) {
  NSWindow *window = (NSWindow *)receiver;
  if (event != nil && isWindowPointInResizeZone(window, event.locationInWindow)) {
    superNativeWidgetCursorUpdate(receiver, selector, event);
    return;
  }
  originalNativeWidgetCursorUpdate(receiver, selector, event);
}

bool configureWindowResizeGuard(void) {
  if (configured) {
    return true;
  }
  if (!NSThread.isMainThread) {
    return false;
  }

  Class renderWidgetClass = objc_getClass("RenderWidgetHostViewCocoa");
  Class nativeWindowClass = objc_getClass("NativeWidgetMacNSWindow");
  if (renderWidgetClass == Nil || nativeWindowClass == Nil) {
    return false;
  }

  resizeDirectionSelector = NSSelectorFromString(@"_resizeDirectionForMouseLocation:");
  Method resizeDirMethod = class_getInstanceMethod(NSWindow.class, resizeDirectionSelector);
  if (!methodMatchesSignature(resizeDirMethod, 3, @encode(NSInteger)) ||
      !argumentTypeMatches(resizeDirMethod, 2, @encode(CGPoint))) {
    return false;
  }

  Method shouldChangeMethod =
      class_getInstanceMethod(renderWidgetClass, @selector(shouldChangeCurrentCursor));
  if (!methodMatchesSignature(shouldChangeMethod, 2, @encode(BOOL))) {
    return false;
  }

  SEL addCursorRectSel = @selector(addCursorRect:cursor:);
  Method addCursorRectMethod = class_getInstanceMethod(renderWidgetClass, addCursorRectSel);
  if (!methodMatchesSignature(addCursorRectMethod, 4, @encode(void)) ||
      !argumentTypeMatches(addCursorRectMethod, 2, @encode(NSRect)) ||
      !argumentTypeMatches(addCursorRectMethod, 3, @encode(id))) {
    return false;
  }

  SEL mouseEventSel = NSSelectorFromString(@"mouseEvent:");
  Method mouseEventMethod = class_getInstanceMethod(renderWidgetClass, mouseEventSel);
  if (!methodMatchesSignature(mouseEventMethod, 3, @encode(void)) ||
      !argumentTypeMatches(mouseEventMethod, 2, @encode(id))) {
    return false;
  }

  Method cursorSetMethod = class_getInstanceMethod(NSCursor.class, @selector(set));
  if (!methodMatchesSignature(cursorSetMethod, 2, @encode(void))) {
    return false;
  }

  Method windowCursorUpdateMethod =
      class_getInstanceMethod(nativeWindowClass, @selector(cursorUpdate:));
  Class nativeWindowSuper = class_getSuperclass(nativeWindowClass);
  Method superCursorUpdateMethod =
      nativeWindowSuper ? class_getInstanceMethod(nativeWindowSuper, @selector(cursorUpdate:)) : NULL;
  if (!methodMatchesSignature(windowCursorUpdateMethod, 3, @encode(void)) ||
      !argumentTypeMatches(windowCursorUpdateMethod, 2, @encode(id)) ||
      !methodMatchesSignature(superCursorUpdateMethod, 3, @encode(void))) {
    return false;
  }

  cornerRadiusSelector = NSSelectorFromString(@"_cornerRadius");
  Method cornerRadiusMethod = class_getInstanceMethod(NSWindow.class, cornerRadiusSelector);
  if (methodMatchesSignature(cornerRadiusMethod, 2, @encode(CGFloat))) {
    windowCornerRadiusFn = (CGFloat (*)(id, SEL))method_getImplementation(cornerRadiusMethod);
  }

  windowResizeDirectionFn = (NSInteger (*)(id, SEL, CGPoint))method_getImplementation(resizeDirMethod);

  originalShouldChangeCurrentCursor = (BOOL (*)(id, SEL))method_getImplementation(shouldChangeMethod);
  method_setImplementation(shouldChangeMethod, (IMP)guardedShouldChangeCurrentCursor);

  superAddCursorRect = (void (*)(id, SEL, NSRect, NSCursor *))method_getImplementation(addCursorRectMethod);
  if (!class_addMethod(
          renderWidgetClass,
          addCursorRectSel,
          (IMP)guardedAddCursorRect,
          method_getTypeEncoding(addCursorRectMethod))) {
    method_setImplementation(addCursorRectMethod, (IMP)guardedAddCursorRect);
  }

  originalCursorSet = (void (*)(id, SEL))method_getImplementation(cursorSetMethod);
  method_setImplementation(cursorSetMethod, (IMP)guardedCursorSet);

  originalMouseEvent = (void (*)(id, SEL, NSEvent *))method_getImplementation(mouseEventMethod);
  method_setImplementation(mouseEventMethod, (IMP)guardedMouseEvent);

  originalNativeWidgetCursorUpdate =
      (void (*)(id, SEL, NSEvent *))method_getImplementation(windowCursorUpdateMethod);
  superNativeWidgetCursorUpdate =
      (void (*)(id, SEL, NSEvent *))method_getImplementation(superCursorUpdateMethod);
  method_setImplementation(windowCursorUpdateMethod, (IMP)guardedNativeWidgetCursorUpdate);

  configured = YES;
  return true;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_get_boolean(env, configureWindowResizeGuard(), &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, NULL, &function);
  napi_set_named_property(env, exports, "configure", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
