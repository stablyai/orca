#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <string.h>

static void RemoveMaterialTint(CALayer *layer) {
  layer.backgroundColor = nil;
  // AppKit builds the tint separately from the blur in the macOS 15 selection material.
  if ([NSStringFromClass(layer.class) isEqualToString:@"CAChameleonLayer"]) {
    layer.hidden = YES;
    return;
  }

  NSArray *filters = layer.filters;
  NSMutableArray *blurFilters = [NSMutableArray arrayWithCapacity:filters.count];
  for (id filter in filters) {
    if (![[filter description] localizedCaseInsensitiveContainsString:@"saturat"]) {
      [blurFilters addObject:filter];
    }
  }
  if (blurFilters.count != filters.count) {
    layer.filters = blurFilters;
  }
  for (CALayer *child in layer.sublayers) {
    RemoveMaterialTint(child);
  }
}

@interface OrcaFrostedGlassView : NSVisualEffectView
@end

@implementation OrcaFrostedGlassView
- (void)updateLayer {
  [super updateLayer];
  RemoveMaterialTint(self.layer);
}
@end

static BOOL UpdateBackdrop(NSView *windowView, BOOL visible) {
  NSWindow *window = windowView.window;
  NSView *contentView = window.contentView;
  if (!contentView) {
    return NO;
  }

  for (NSView *view in contentView.subviews) {
    if ([view isKindOfClass:OrcaFrostedGlassView.class]) {
      if (!visible) {
        [view removeFromSuperview];
      }
      return YES;
    }
  }
  if (!visible) {
    return YES;
  }

  OrcaFrostedGlassView *glass = [[OrcaFrostedGlassView alloc] initWithFrame:contentView.bounds];
  glass.material = NSVisualEffectMaterialSelection;
  glass.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  glass.state = NSVisualEffectStateActive;
  glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  window.opaque = NO;
  window.backgroundColor = NSColor.clearColor;
  [contentView addSubview:glass positioned:NSWindowBelow relativeTo:nil];
  return YES;
}

static napi_value SetBackdrop(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2;
  void *handle = NULL;
  size_t handleSize = 0;
  bool visible = false;
  void *view = NULL;

  if (NSThread.isMainThread &&
      NSProcessInfo.processInfo.operatingSystemVersion.majorVersion == 15 &&
      napi_get_cb_info(env, info, &argc, args, NULL, NULL) == napi_ok && argc == 2 &&
      napi_get_buffer_info(env, args[0], &handle, &handleSize) == napi_ok &&
      handleSize == sizeof(view) &&
      napi_get_value_bool(env, args[1], &visible) == napi_ok) {
    // Electron returns a Buffer containing the NSView pointer, rather than the pointer itself.
    memcpy(&view, handle, sizeof(view));
  }

  napi_value result;
  napi_get_boolean(env, view && UpdateBackdrop((__bridge NSView *)view, visible), &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value setter;
  napi_create_function(env, "setBackdrop", NAPI_AUTO_LENGTH, SetBackdrop, NULL, &setter);
  napi_set_named_property(env, exports, "setBackdrop", setter);
  return exports;
}

NAPI_MODULE(orca_frosted_glass, Init)
