// Native Ghostty terminal surfaces overlaid on an Electron BrowserWindow (macOS).
//
// Ghostty renders with Metal and encodes input; Orca's terminal daemon keeps owning the PTY.
// Output reaches the surface through write_buffer_replay so Ghostty never answers terminal
// queries (Orca's existing emulator already does), and keystrokes come back as encoded bytes.
//
// Input handling in OrcaGhosttySurfaceView is adapted from Ghostty's SurfaceView_AppKit.swift
// (MIT, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors).

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <node_api.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <termios.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <string>

#include "ghostty.h"

namespace {

struct SurfaceEvent;

struct SurfaceModel {
  int32_t id = 0;
  ghostty_surface_t surface = nullptr;
  napi_threadsafe_function events = nullptr;
  bool closed = false;
  // A config of this surface's own (per-pane font size); null follows the app config.
  ghostty_config_t config = nullptr;
  // Focus reports from a focus round trip of our own, which the PTY must not see.
  std::atomic<int> swallowed_focus_reports{0};
};

// No C++ globals with dynamic constructors: Xcode's linker rejects them in this bundle.
ghostty_app_t g_app = nullptr;
ghostty_config_t g_config = nullptr;
std::atomic<bool> g_tick_pending{false};
// Idle-cost counters for debugCounters; E2E asserts an idle window adds none.
std::atomic<uint64_t> g_tick_count{0};
uint64_t g_set_frames_count = 0;
uint64_t g_presented_frames = 0;
// Windows seen on screen at least once; one never shown (a background launch) keeps drawing.
NSHashTable<NSWindow*>* g_shown_windows = nil;
// debugWindowOcclusion: -1 follows AppKit, 0 forces every window occluded, 1 on screen.
int g_window_occlusion_override = -1;
// KVO context for the layer contents Ghostty swaps on every presented frame.
char g_presented_frames_context = 0;
std::atomic<int32_t> g_next_id{1};
NSMutableDictionary<NSNumber*, id>* g_views = nil;

enum class SurfaceEventKind {
  Input,
  Resize,
  Focus,
  Key,
  Title,
  Pwd,
  OpenUrl,
  Bell,
  MouseShape,
  ContextMenu,
  MouseEnter,
  DoubleTapInput,
  ServicePaste
};

struct SurfaceEvent {
  SurfaceEventKind kind;
  std::string text;
  uint32_t a = 0, b = 0, c = 0, d = 0;
};

void Emit(SurfaceModel* model, SurfaceEvent* event) {
  if (model == nullptr || model->events == nullptr || model->closed) {
    delete event;
    return;
  }
  if (napi_call_threadsafe_function(model->events, event, napi_tsfn_nonblocking) != napi_ok) {
    delete event;
  }
}

ghostty_input_mods_e GhosttyMods(NSEventModifierFlags flags) {
  uint32_t mods = GHOSTTY_MODS_NONE;
  if (flags & NSEventModifierFlagShift) mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;
  const NSUInteger raw = flags;
  if (raw & NX_DEVICERSHIFTKEYMASK) mods |= GHOSTTY_MODS_SHIFT_RIGHT;
  if (raw & NX_DEVICERCTLKEYMASK) mods |= GHOSTTY_MODS_CTRL_RIGHT;
  if (raw & NX_DEVICERALTKEYMASK) mods |= GHOSTTY_MODS_ALT_RIGHT;
  if (raw & NX_DEVICERCMDKEYMASK) mods |= GHOSTTY_MODS_SUPER_RIGHT;
  return static_cast<ghostty_input_mods_e>(mods);
}

NSEventModifierFlags EventFlags(ghostty_input_mods_e mods) {
  NSEventModifierFlags flags = 0;
  if (mods & GHOSTTY_MODS_SHIFT) flags |= NSEventModifierFlagShift;
  if (mods & GHOSTTY_MODS_CTRL) flags |= NSEventModifierFlagControl;
  if (mods & GHOSTTY_MODS_ALT) flags |= NSEventModifierFlagOption;
  if (mods & GHOSTTY_MODS_SUPER) flags |= NSEventModifierFlagCommand;
  if (mods & GHOSTTY_MODS_CAPS) flags |= NSEventModifierFlagCapsLock;
  return flags;
}

ghostty_input_key_s KeyEvent(NSEvent* event, ghostty_input_action_e action, NSEventModifierFlags translationFlags) {
  ghostty_input_key_s key = {};
  key.action = action;
  key.keycode = event.keyCode;
  key.text = nullptr;
  key.composing = false;
  // Control and command never contribute to text translation on macOS.
  key.mods = GhosttyMods(event.modifierFlags);
  key.consumed_mods =
      GhosttyMods(translationFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.unshifted_codepoint = 0;
  if (event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp) {
    NSString* chars = [event charactersByApplyingModifiers:0];
    if (chars.length > 0) {
      key.unshifted_codepoint = static_cast<uint32_t>([chars characterAtIndex:0]);
    }
  }
  return key;
}

// Control characters are encoded by Ghostty itself; PUA function-key glyphs carry no text.
NSString* GhosttyCharacters(NSEvent* event) {
  NSString* chars = event.characters;
  if (chars == nil) return nil;
  if (chars.length == 1) {
    const unichar scalar = [chars characterAtIndex:0];
    if (scalar < 0x20) {
      return [event charactersByApplyingModifiers:(event.modifierFlags & ~NSEventModifierFlagControl)];
    }
    if (scalar >= 0xF700 && scalar <= 0xF8FF) return nil;
  }
  return chars;
}

bool IsSingleControl(NSString* text) {
  if (text.length != 1) return false;
  return [text characterAtIndex:0] < 0x20;
}

NSString* KeyboardLayoutId() {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  if (source == nullptr) return nil;
  NSString* layout = (__bridge NSString*)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
  NSString* copy = [layout copy];
  CFRelease(source);
  return copy;
}

void ScheduleTick() {
  if (g_tick_pending.exchange(true)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    g_tick_pending.store(false);
    g_tick_count.fetch_add(1, std::memory_order_relaxed);
    if (g_app != nullptr) ghostty_app_tick(g_app);
  });
}

}  // namespace

namespace {

#pragma mark Host-owned chords

// A non-Command chord Orca intercepts while a terminal is focused (Ctrl+Tab, user bindings).
struct ForwardedChord {
  uint16_t keyCode;
  uint32_t modifiers;
  // Lowercase unmodified character for layout-dependent keys; 0 matches by keyCode instead.
  unichar character;
};

constexpr NSEventModifierFlags kChordModifiers =
    NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand;

// Replaced wholesale by setForwardedChords; plain data so the bundle keeps no dynamic initializers.
ForwardedChord* g_forwarded_chords = nullptr;
size_t g_forwarded_chord_count = 0;

bool IsForwardedChord(NSEvent* event) {
  if (g_forwarded_chord_count == 0) return false;
  const auto modifiers = static_cast<uint32_t>(event.modifierFlags & kChordModifiers);
  NSString* base = [[event charactersByApplyingModifiers:0] lowercaseString];
  const unichar character = base.length == 1 ? [base characterAtIndex:0] : 0;
  for (size_t i = 0; i < g_forwarded_chord_count; i++) {
    const ForwardedChord& chord = g_forwarded_chords[i];
    if (chord.modifiers != modifiers) continue;
    if (chord.character != 0 ? chord.character == character : chord.keyCode == event.keyCode) return true;
  }
  return false;
}

// True when some forwarded entry names a modifier key: a double-tap binding Orca detects.
bool g_double_tap_watch = false;

bool IsModifierKeyCode(uint16_t keyCode) {
  return keyCode >= kVK_RightCommand && keyCode <= kVK_RightControl && keyCode != kVK_CapsLock;
}

bool IsDoubleTapWatched(uint16_t keyCode) {
  if (!g_double_tap_watch) return false;
  for (size_t i = 0; i < g_forwarded_chord_count; i++) {
    if (g_forwarded_chords[i].keyCode == keyCode) return true;
  }
  return false;
}

NSEventModifierFlags ModifierFlagForKeyCode(uint16_t keyCode) {
  switch (keyCode) {
    case kVK_Shift: case kVK_RightShift: return NSEventModifierFlagShift;
    case kVK_Control: case kVK_RightControl: return NSEventModifierFlagControl;
    case kVK_Option: case kVK_RightOption: return NSEventModifierFlagOption;
    default: return NSEventModifierFlagCommand;
  }
}

// Left-hand key for a modifier flag, unless the flagsChanged event names its right-hand twin.
uint16_t ModifierKeyCode(NSEventModifierFlags flag, uint16_t changedKeyCode) {
  switch (flag) {
    case NSEventModifierFlagShift: return changedKeyCode == kVK_RightShift ? kVK_RightShift : kVK_Shift;
    case NSEventModifierFlagControl: return changedKeyCode == kVK_RightControl ? kVK_RightControl : kVK_Control;
    case NSEventModifierFlagOption: return changedKeyCode == kVK_RightOption ? kVK_RightOption : kVK_Option;
    default: return changedKeyCode == kVK_RightCommand ? kVK_RightCommand : kVK_Command;
  }
}

}  // namespace

namespace {

#pragma mark Surface text and secure input (declarations)

// The whole viewport as text, read without touching the user's selection.
NSString* ReadViewportText(ghostty_surface_t surface) {
  if (surface == nullptr) return @"";
  ghostty_selection_s viewport = {};
  viewport.top_left = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_TOP_LEFT, 0, 0};
  viewport.bottom_right = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_BOTTOM_RIGHT, 0, 0};
  viewport.rectangle = false;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(surface, viewport, &text)) return @"";
  NSString* result = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding];
  ghostty_surface_free_text(surface, &text);
  return result ?: @"";
}

// Re-derives Secure Keyboard Entry and Ghostty focus from which surface holds the keyboard;
// defined below.
void UpdateSecureInput();

// Whether a window is on screen for its surfaces' purposes (minimized, hidden or covered is not).
bool WindowOnScreen(NSWindow* window) {
  if (window == nil) return false;
  if (g_window_occlusion_override >= 0) return g_window_occlusion_override == 1;
  if (window.occlusionState & NSWindowOcclusionStateVisible) {
    [g_shown_windows addObject:window];
    return true;
  }
  return ![g_shown_windows containsObject:window];
}

}  // namespace

// Flipped so frames match DOM coordinates; hit-testing falls through to web contents
// everywhere except over a visible surface.
@interface OrcaGhosttyHostView : NSView
@end

@implementation OrcaGhosttyHostView
- (BOOL)isFlipped {
  return YES;
}
- (NSView*)hitTest:(NSPoint)point {
  NSView* hit = [super hitTest:point];
  return hit == self ? nil : hit;
}
@end

@interface OrcaGhosttySurfaceView : NSView <NSTextInputClient>
@property(nonatomic, assign) SurfaceModel* model;
// What Ghostty was last told: it blinks, reports focus and redraws only a focused surface, and
// draws (holding its swap chain) only a visible one.
@property(nonatomic, readonly) BOOL ghosttyFocused;
@property(nonatomic, readonly) BOOL ghosttyVisible;
@property(nonatomic, readonly) uint64_t presentedFrames;
// Between becomeFirstResponder and resignFirstResponder; AppKit still reports a resigning view
// as the window's first responder.
@property(nonatomic, readonly) BOOL keyboardFocused;
@property(nonatomic, readonly) uint64_t strayCursorTimers;
- (void)setOverlayHoles:(NSArray<NSValue*>*)holes;
- (NSArray<NSValue*>*)overlayHoles;
- (void)setGhosttyFocused:(BOOL)focused;
- (void)syncGhosttyVisible;
- (void)noteOutput;
- (void)observePresentedFrames;
- (void)stopObservingPresentedFrames;
@end

// Not registered for dragged types on purpose: AppKit then routes drags over the surface to the
// web contents beneath, where Orca's DOM drop owner for the pane handles them as usual.
@interface OrcaGhosttySurfaceView () {
  // Modifiers still held from a chord handed to Orca, whose release Orca also needs.
  NSEventModifierFlags _hostHeldModifiers;
  id _hostModifierMonitor;
  NSMutableIndexSet* _hostForwardedKeyCodes;
}
@end

@interface OrcaGhosttySurfaceView () {
  // VoiceOver reads the value many times per announcement; Ghostty caches it the same way.
  NSString* _accessibilityText;
  CFAbsoluteTime _accessibilityTextTime;
}
@end

@interface OrcaGhosttySurfaceView (HostInput)
- (void)reportDoubleTapInput:(NSEvent*)event;
- (void)forwardChordToHost:(NSEvent*)event;
- (BOOL)consumeHostKeyUp:(NSEvent*)event;
- (void)hostModifiersChanged:(NSEvent*)event;
- (void)endHostModifierTracking;
- (void)emitMouseEntered:(NSEvent*)event;
@end

@implementation OrcaGhosttySurfaceView {
  // The layer whose contents Ghostty swaps per presented frame.
  CALayer* _presentedLayer;
  // For spotting Ghostty's cursor timer on an unfocused surface (see presentedFrame).
  CFTimeInterval _lastOutputTime;
  CFTimeInterval _lastUnfocusedFrameTime;
  int _cursorCadenceFrames;
  NSMutableAttributedString* _markedText;
  NSMutableArray<NSString*>* _keyTextAccumulator;
  NSTrackingArea* _trackingArea;
  BOOL _focused;
  // DOM overlays showing through this view, in view coordinates; nil when none.
  NSArray<NSValue*>* _overlayHoles;
}

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    _markedText = [[NSMutableAttributedString alloc] init];
    // Ghostty's own starting state for a new surface.
    _ghosttyFocused = YES;
    _ghosttyVisible = YES;
  }
  return self;
}

- (void)setGhosttyFocused:(BOOL)focused {
  if (_ghosttyFocused == focused || !self.surface) return;
  _ghosttyFocused = focused;
  ghostty_surface_set_focus(self.surface, focused);
}

- (void)noteOutput {
  _lastOutputTime = CACurrentMediaTime();
}

// Ghostty can leave its 600 ms cursor timer running on a surface it was told is unfocused: an
// output's reset_cursor_blink, drained in the same batch as the unfocus, turns the pending
// cancel into a re-arm (libxev timer_reset). Two frames 600 ms apart with no output between
// are that timer (the window allows for a loaded main thread); another unfocus, sent while no
// output is in flight, cancels it.
- (void)presentedFrame {
  if (_ghosttyFocused || !_ghosttyVisible || !self.surface) {
    _cursorCadenceFrames = 0;
    return;
  }
  const CFTimeInterval now = CACurrentMediaTime();
  const CFTimeInterval interval = now - _lastUnfocusedFrameTime;
  const bool timerTick = interval > 0.4 && interval < 1.5 && _lastOutputTime < _lastUnfocusedFrameTime;
  _cursorCadenceFrames = timerTick ? _cursorCadenceFrames + 1 : 0;
  _lastUnfocusedFrameTime = now;
  if (_cursorCadenceFrames < 2) return;
  _cursorCadenceFrames = 0;
  _strayCursorTimers++;
  SurfaceModel* model = self.model;
  model->swallowed_focus_reports.store(2);
  ghostty_surface_set_focus(self.surface, true);
  ghostty_surface_set_focus(self.surface, false);
  // Without focus reporting on, Ghostty sends none to swallow.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (self.model == model) model->swallowed_focus_reports.store(0);
  });
}

- (void)syncGhosttyVisible {
  const BOOL visible = !self.hidden && WindowOnScreen(self.window);
  if (_ghosttyVisible == visible || !self.surface) return;
  _ghosttyVisible = visible;
  ghostty_surface_set_occlusion(self.surface, visible);
}

- (void)observePresentedFrames {
  _presentedLayer = self.layer;
  [_presentedLayer addObserver:self forKeyPath:@"contents" options:0 context:&g_presented_frames_context];
}

- (void)stopObservingPresentedFrames {
  [_presentedLayer removeObserver:self forKeyPath:@"contents" context:&g_presented_frames_context];
  _presentedLayer = nil;
}

- (void)observeValueForKeyPath:(NSString*)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id>*)change
                       context:(void*)context {
  if (context != &g_presented_frames_context) {
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    return;
  }
  _presentedFrames++;
  g_presented_frames++;
  [self presentedFrame];
}

- (ghostty_surface_t)surface {
  return self.model ? self.model->surface : nullptr;
}

- (BOOL)keyboardFocused {
  return _focused;
}

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent*)event {
  return YES;
}

- (BOOL)becomeFirstResponder {
  BOOL result = [super becomeFirstResponder];
  if (result) [self focusDidChange:YES];
  return result;
}

- (BOOL)resignFirstResponder {
  BOOL result = [super resignFirstResponder];
  if (result) [self focusDidChange:NO];
  return result;
}

- (void)focusDidChange:(BOOL)focused {
  if (_focused == focused) return;
  _focused = focused;
  auto* event = new SurfaceEvent{SurfaceEventKind::Focus};
  event->a = focused ? 1 : 0;
  Emit(self.model, event);
  UpdateSecureInput();
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingInVisibleRect |
                   NSTrackingActiveAlways
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)syncSurfaceSize {
  if (!self.surface) return;
  NSSize backing = [self convertSizeToBacking:self.bounds.size];
  if (backing.width < 1 || backing.height < 1) return;
  ghostty_surface_set_size(self.surface, static_cast<uint32_t>(backing.width),
                           static_cast<uint32_t>(backing.height));
}

- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [self syncSurfaceSize];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  if (self.window) {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.layer.contentsScale = self.window.backingScaleFactor;
    [CATransaction commit];
  }
  if (!self.surface || self.bounds.size.width <= 0 || self.bounds.size.height <= 0) return;
  NSRect fb = [self convertRectToBacking:self.bounds];
  ghostty_surface_set_content_scale(self.surface, fb.size.width / self.bounds.size.width,
                                    fb.size.height / self.bounds.size.height);
  [self syncSurfaceSize];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  NSScreen* screen = self.window.screen;
  if (self.surface && screen) {
    NSNumber* displayId = screen.deviceDescription[@"NSScreenNumber"];
    ghostty_surface_set_display_id(self.surface, displayId.unsignedIntValue);
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self viewDidChangeBackingProperties];
  });
}

#pragma mark Overlay holes

// An even-odd mask cuts the holes out of what the view draws (scrollbar included), and
// hit-testing lets clicks and the wheel over them reach the web contents underneath.
- (void)setOverlayHoles:(NSArray<NSValue*>*)holes {
  _overlayHoles = holes.count > 0 ? [holes copy] : nil;
  CALayer* layer = self.layer;
  if (layer == nil) return;
  if (_overlayHoles == nil) {
    layer.mask = nil;
    return;
  }
  CAShapeLayer* mask =
      [layer.mask isKindOfClass:[CAShapeLayer class]] ? (CAShapeLayer*)layer.mask : [CAShapeLayer layer];
  mask.frame = layer.bounds;
  mask.fillRule = kCAFillRuleEvenOdd;
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathAddRect(path, nullptr, mask.bounds);
  for (NSValue* hole in _overlayHoles) {
    CGPathAddRect(path, nullptr, NSRectToCGRect([self convertRectToLayer:hole.rectValue]));
  }
  mask.path = path;
  CGPathRelease(path);
  layer.mask = mask;
}

- (NSArray<NSValue*>*)overlayHoles {
  return _overlayHoles;
}

- (BOOL)overlayHoleContains:(NSPoint)point {
  for (NSValue* hole in _overlayHoles) {
    if (NSPointInRect(point, hole.rectValue)) return YES;
  }
  return NO;
}

- (NSView*)hitTest:(NSPoint)point {
  if (_overlayHoles != nil && [self overlayHoleContains:[self convertPoint:point fromView:self.superview]]) {
    return nil;
  }
  return [super hitTest:point];
}

#pragma mark Mouse

- (void)sendMousePos:(NSEvent*)event {
  if (!self.surface) return;
  NSPoint pos = [self convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(self.surface, pos.x, self.frame.size.height - pos.y,
                            GhosttyMods(event.modifierFlags));
}

- (void)mouseDown:(NSEvent*)event {
  if (self.window.firstResponder != self) [self.window makeFirstResponder:self];
  if (!self.surface) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseUp:(NSEvent*)event {
  if (!self.surface) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
  ghostty_surface_mouse_pressure(self.surface, 0, 0);
}

- (void)rightMouseDown:(NSEvent*)event {
  if (self.surface && ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT,
                                                   GhosttyMods(event.modifierFlags))) {
    return;
  }
  // Not claimed by mouse reporting: Orca's pane context menu lives in the web contents.
  NSView* content = self.window.contentView;
  NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
  auto* forwarded = new SurfaceEvent{SurfaceEventKind::ContextMenu};
  forwarded->a = static_cast<uint32_t>(MAX(0, point.x));
  forwarded->b = static_cast<uint32_t>(MAX(0, content.bounds.size.height - point.y));
  Emit(self.model, forwarded);
}

- (void)rightMouseUp:(NSEvent*)event {
  if (self.surface && ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT,
                                                   GhosttyMods(event.modifierFlags))) {
    return;
  }
  [super rightMouseUp:event];
}

- (void)otherMouseDown:(NSEvent*)event {
  if (!self.surface || event.buttonNumber != 2) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_MIDDLE,
                               GhosttyMods(event.modifierFlags));
}

- (void)otherMouseUp:(NSEvent*)event {
  if (!self.surface || event.buttonNumber != 2) return;
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_MIDDLE,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseEntered:(NSEvent*)event {
  [super mouseEntered:event];
  if ([self overlayHoleContains:[self convertPoint:event.locationInWindow fromView:nil]]) return;
  [self sendMousePos:event];
  [self emitMouseEntered:event];
}

- (void)mouseExited:(NSEvent*)event {
  if (!self.surface || NSEvent.pressedMouseButtons != 0) return;
  // Negative coordinates tell Ghostty the cursor left the viewport.
  ghostty_surface_mouse_pos(self.surface, -1, -1, GhosttyMods(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent*)event {
  // Hovering the overlay in a hole: Ghostty sees the pointer leave, not a hover underneath.
  if ([self overlayHoleContains:[self convertPoint:event.locationInWindow fromView:nil]]) {
    [self mouseExited:event];
    return;
  }
  [self sendMousePos:event];
}

- (void)mouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)rightMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)otherMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)scrollWheel:(NSEvent*)event {
  if (!self.surface) return;
  double x = event.scrollingDeltaX;
  double y = event.scrollingDeltaY;
  const bool precision = event.hasPreciseScrollingDeltas;
  if (precision) {
    x *= 2;
    y *= 2;
  }
  int momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  const NSEventPhase phase = event.momentumPhase;
  if (phase & NSEventPhaseBegan) momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;
  else if (phase & NSEventPhaseStationary) momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY;
  else if (phase & NSEventPhaseChanged) momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;
  else if (phase & NSEventPhaseEnded) momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;
  else if (phase & NSEventPhaseCancelled) momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
  else if (phase & NSEventPhaseMayBegin) momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;
  const ghostty_input_scroll_mods_t mods = (precision ? 1 : 0) | (momentum << 1);
  ghostty_surface_mouse_scroll(self.surface, x, y, mods);
}

- (void)pressureChangeWithEvent:(NSEvent*)event {
  if (!self.surface) return;
  ghostty_surface_mouse_pressure(self.surface, static_cast<uint32_t>(event.stage), event.pressure);
}

#pragma mark Keyboard

// Command chords belong to Orca (menus, tab and pane shortcuts), not the terminal, and so do
// the other chords Orca pushed through setForwardedChords.
- (BOOL)forwardsToHost:(NSEvent*)event {
  if (_markedText.length > 0) return NO;
  return (event.modifierFlags & NSEventModifierFlagCommand) != 0 || IsForwardedChord(event);
}

- (void)emitForwardedKey:(NSEvent*)event {
  auto* forwarded = new SurfaceEvent{SurfaceEventKind::Key};
  // Unshifted so the host sees the physical key plus a shift modifier, like a DOM keydown.
  NSString* chars = [event charactersByApplyingModifiers:0] ?: @"";
  forwarded->text = chars.UTF8String ?: "";
  forwarded->a = event.keyCode;
  forwarded->b = static_cast<uint32_t>(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask);
  forwarded->c = event.isARepeat ? 1 : 0;
  Emit(self.model, forwarded);
}

- (BOOL)performKeyEquivalent:(NSEvent*)event {
  // Returning NO lets the main menu (Electron accelerators) try the chord; if nothing
  // claims it AppKit delivers it to keyDown, which forwards it to the renderer.
  return NO;
}

- (BOOL)keyAction:(ghostty_input_action_e)action
            event:(NSEvent*)event
 translationEvent:(NSEvent*)translationEvent
             text:(NSString*)text
        composing:(BOOL)composing {
  if (!self.surface) return NO;
  ghostty_input_key_s key =
      KeyEvent(event, action, translationEvent ? translationEvent.modifierFlags : event.modifierFlags);
  key.composing = composing;
  if (text.length > 0 && [text characterAtIndex:0] >= 0x20) {
    key.text = text.UTF8String;
  }
  return ghostty_surface_key(self.surface, key);
}

- (BOOL)committedTextAction:(ghostty_input_action_e)action text:(NSString*)text {
  if (!self.surface) return NO;
  ghostty_input_key_s key = {};
  key.action = action;
  key.mods = GHOSTTY_MODS_NONE;
  key.consumed_mods = GHOSTTY_MODS_NONE;
  key.text = text.UTF8String;
  return ghostty_surface_key(self.surface, key);
}

- (BOOL)shouldReplayCommittedPreeditKey:(NSEvent*)event {
  switch (event.keyCode) {
    case kVK_DownArrow:
    case kVK_RightArrow:
    case kVK_UpArrow:
      return YES;
    case kVK_LeftArrow:
      // Korean IMEs already leave the caret in place after committing.
      return (event.modifierFlags & (NSEventModifierFlagShift | NSEventModifierFlagControl |
                                     NSEventModifierFlagOption | NSEventModifierFlagCommand)) != 0;
    default:
      return NO;
  }
}

- (void)syncPreedit:(BOOL)clearIfNeeded {
  if (!self.surface) return;
  if (_markedText.length > 0) {
    const char* utf8 = _markedText.string.UTF8String;
    ghostty_surface_preedit(self.surface, utf8, strlen(utf8));
  } else if (clearIfNeeded) {
    ghostty_surface_preedit(self.surface, nullptr, 0);
  }
}

- (void)keyDown:(NSEvent*)event {
  if (!self.surface) {
    [self interpretKeyEvents:@[ event ]];
    return;
  }
  [self reportDoubleTapInput:event];
  if ([self forwardsToHost:event]) {
    [self forwardChordToHost:event];
    return;
  }

  // Option-as-alt and friends change which modifiers translate text.
  NSEventModifierFlags ghosttyTranslation =
      EventFlags(ghostty_surface_key_translation_mods(self.surface, GhosttyMods(event.modifierFlags)));
  NSEventModifierFlags translationFlags = event.modifierFlags;
  for (NSEventModifierFlags flag : {NSEventModifierFlagShift, NSEventModifierFlagControl,
                                    NSEventModifierFlagOption, NSEventModifierFlagCommand}) {
    if (ghosttyTranslation & flag) translationFlags |= flag;
    else translationFlags &= ~flag;
  }
  // Reusing the original event when nothing changed keeps Korean input working.
  NSEvent* translationEvent = event;
  if (translationFlags != event.modifierFlags) {
    translationEvent = [NSEvent keyEventWithType:event.type
                                        location:event.locationInWindow
                                   modifierFlags:translationFlags
                                       timestamp:event.timestamp
                                    windowNumber:event.windowNumber
                                         context:nil
                                      characters:[event charactersByApplyingModifiers:translationFlags] ?: @""
                     charactersIgnoringModifiers:event.charactersIgnoringModifiers ?: @""
                                       isARepeat:event.isARepeat
                                         keyCode:event.keyCode] ?: event;
  }

  const ghostty_input_action_e action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  _keyTextAccumulator = [NSMutableArray array];
  const BOOL markedTextBefore = _markedText.length > 0;
  NSString* layoutBefore = markedTextBefore ? nil : KeyboardLayoutId();

  [self interpretKeyEvents:@[ translationEvent ]];

  NSArray<NSString*>* accumulated = _keyTextAccumulator;
  _keyTextAccumulator = nil;

  // A layout switch shortcut was consumed by the input method.
  if (!markedTextBefore && layoutBefore && ![layoutBefore isEqualToString:KeyboardLayoutId() ?: @""]) {
    return;
  }

  [self syncPreedit:markedTextBefore];
  const BOOL composing = _markedText.length > 0 || markedTextBefore;

  if (markedTextBefore && accumulated.count > 0) {
    for (NSString* text in accumulated) {
      if (composing && IsSingleControl(text)) continue;
      [self committedTextAction:action text:text];
    }
    if ([self shouldReplayCommittedPreeditKey:translationEvent]) {
      [self keyAction:action event:event translationEvent:translationEvent text:nil composing:NO];
    }
    return;
  }

  if (accumulated.count > 0) {
    for (NSString* text in accumulated) {
      if (composing && IsSingleControl(text)) continue;
      [self keyAction:action event:event translationEvent:translationEvent text:text composing:NO];
    }
    return;
  }

  if (composing && IsSingleControl(event.characters)) return;
  [self keyAction:action
                 event:event
      translationEvent:translationEvent
                  text:GhosttyCharacters(translationEvent)
             composing:composing];
}

- (void)keyUp:(NSEvent*)event {
  if ([self consumeHostKeyUp:event] || [self forwardsToHost:event]) return;
  [self keyAction:GHOSTTY_ACTION_RELEASE event:event translationEvent:nil text:nil composing:NO];
}

- (void)flagsChanged:(NSEvent*)event {
  [self reportDoubleTapInput:event];
  uint32_t mod = 0;
  switch (event.keyCode) {
    case 0x39: mod = GHOSTTY_MODS_CAPS; break;
    case 0x38: case 0x3C: mod = GHOSTTY_MODS_SHIFT; break;
    case 0x3B: case 0x3E: mod = GHOSTTY_MODS_CTRL; break;
    case 0x3A: case 0x3D: mod = GHOSTTY_MODS_ALT; break;
    case 0x37: case 0x36: mod = GHOSTTY_MODS_SUPER; break;
    default: return;
  }
  if (_markedText.length > 0) return;
  ghostty_input_action_e action = GHOSTTY_ACTION_RELEASE;
  if (GhosttyMods(event.modifierFlags) & mod) {
    const NSUInteger raw = event.modifierFlags;
    bool sidePressed = true;
    switch (event.keyCode) {
      case 0x3C: sidePressed = raw & NX_DEVICERSHIFTKEYMASK; break;
      case 0x3E: sidePressed = raw & NX_DEVICERCTLKEYMASK; break;
      case 0x3D: sidePressed = raw & NX_DEVICERALTKEYMASK; break;
      case 0x36: sidePressed = raw & NX_DEVICERCMDKEYMASK; break;
      default: break;
    }
    if (sidePressed) action = GHOSTTY_ACTION_PRESS;
  }
  [self keyAction:action event:event translationEvent:nil text:nil composing:NO];
}

- (void)doCommandBySelector:(SEL)selector {
  // Swallow AppKit editing commands (no beep); Ghostty already encoded the key.
}

#pragma mark Clipboard and menu actions

- (IBAction)copy:(id)sender {
  if (self.surface) ghostty_surface_binding_action(self.surface, "copy_to_clipboard", strlen("copy_to_clipboard"));
}

- (IBAction)paste:(id)sender {
  if (self.surface) {
    ghostty_surface_binding_action(self.surface, "paste_from_clipboard", strlen("paste_from_clipboard"));
  }
}

- (IBAction)selectAll:(id)sender {
  if (self.surface) ghostty_surface_binding_action(self.surface, "select_all", strlen("select_all"));
}

- (BOOL)validateMenuItem:(NSMenuItem*)item {
  if (item.action == @selector(copy:)) return self.surface && ghostty_surface_has_selection(self.surface);
  return YES;
}

#pragma mark NSTextInputClient

- (BOOL)hasMarkedText {
  return _markedText.length > 0;
}

- (NSRange)markedRange {
  return _markedText.length > 0 ? NSMakeRange(0, _markedText.length) : NSMakeRange(NSNotFound, 0);
}

- (NSRange)selectedRange {
  if (!self.surface) return NSMakeRange(NSNotFound, 0);
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(self.surface, &text)) return NSMakeRange(NSNotFound, 0);
  NSRange range = NSMakeRange(text.offset_start, text.offset_len);
  ghostty_surface_free_text(self.surface, &text);
  return range;
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
  if ([string isKindOfClass:[NSAttributedString class]]) {
    _markedText = [[NSMutableAttributedString alloc] initWithAttributedString:string];
  } else if ([string isKindOfClass:[NSString class]]) {
    _markedText = [[NSMutableAttributedString alloc] initWithString:string];
  }
  // Outside keyDown (e.g. a layout change mid-composition) preedit must update now.
  if (_keyTextAccumulator == nil) [self syncPreedit:YES];
}

- (void)unmarkText {
  if (_markedText.length > 0) {
    [_markedText.mutableString setString:@""];
    [self syncPreedit:YES];
  }
}

- (NSArray<NSAttributedStringKey>*)validAttributesForMarkedText {
  return @[];
}

// Like Ghostty: system callers (dictation, look-up) ask for odd ranges, so answer with the selection.
- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  if (!self.surface || range.length == 0) return nil;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(self.surface, &text)) return nil;
  NSString* selection = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding];
  ghostty_surface_free_text(self.surface, &text);
  NSMutableDictionary<NSAttributedStringKey, id>* attributes = [NSMutableDictionary dictionary];
  if (void* font = ghostty_surface_quicklook_font(self.surface)) {
    attributes[NSFontAttributeName] = (__bridge_transfer NSFont*)font;
  }
  return selection ? [[NSAttributedString alloc] initWithString:selection attributes:attributes] : nil;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
  return 0;
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
  if (!self.surface) return NSMakeRect(self.frame.origin.x, self.frame.origin.y, 0, 0);
  double x = 0, y = 0, width = 0, height = 0;
  ghostty_surface_ime_point(self.surface, &x, &y, &width, &height);
  const ghostty_surface_size_s size = ghostty_surface_size(self.surface);
  const CGFloat scale = self.window ? self.window.backingScaleFactor : 1;
  const double cellWidth = size.cell_width_px / scale;
  const double cellHeight = size.cell_height_px / scale;
  if (range.length == 0 && width > 0) {
    // Ghostty's fix for speech and dictation: a caret, advanced to the requested location.
    width = 0;
    if (range.location != NSNotFound) x += cellWidth * static_cast<double>(range.location);
  }
  NSRect viewRect = NSMakeRect(x, self.frame.size.height - y, width, MAX(height, cellHeight));
  NSRect windowRect = [self convertRect:viewRect toView:nil];
  return self.window ? [self.window convertRectToScreen:windowRect] : windowRect;
}

- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
  if (NSApp.currentEvent == nil) return;
  NSString* chars = [string isKindOfClass:[NSAttributedString class]] ? [string string] : string;
  if (![chars isKindOfClass:[NSString class]]) return;
  [self unmarkText];
  if (_keyTextAccumulator != nil) {
    [_keyTextAccumulator addObject:chars];
    return;
  }
  // Committed IME/dictation text is typed input, never a paste.
  if (chars.length > 0) [self committedTextAction:GHOSTTY_ACTION_PRESS text:chars];
}

@end

#pragma mark Scrollbar

// Flipped so a row offset is the clip view's y origin.
@interface OrcaGhosttyScrollDocumentView : NSView
@end

@implementation OrcaGhosttyScrollDocumentView
- (BOOL)isFlipped {
  return YES;
}
@end

// Tells scroller-driven clip view moves (knob drags, track clicks) apart from layout-driven ones.
@interface OrcaGhosttyScroller : NSScroller
@property(nonatomic, readonly) BOOL tracking;
@end

@implementation OrcaGhosttyScroller
+ (BOOL)isCompatibleWithOverlayScrollers {
  return YES;
}

- (void)mouseDown:(NSEvent*)event {
  // NSScroller tracks the whole drag inside mouseDown.
  _tracking = YES;
  [super mouseDown:event];
  _tracking = NO;
}
@end

// A scroller-wide NSScrollView pinned to the surface's right edge: AppKit draws the overlay
// scroller (fade, hover expansion, track clicks) while Ghostty keeps owning the viewport.
// Rows map proportionally onto the strip, so the knob is len/total of the track.
@interface OrcaGhosttyScrollbarView : NSScrollView
@property(nonatomic, weak) OrcaGhosttySurfaceView* surfaceView;
@property(nonatomic, readonly) uint64_t total;
@property(nonatomic, readonly) uint64_t offset;
@property(nonatomic, readonly) uint64_t len;
+ (instancetype)scrollbarOf:(OrcaGhosttySurfaceView*)surfaceView create:(BOOL)create;
- (void)applyTotal:(uint64_t)total offset:(uint64_t)offset len:(uint64_t)len;
- (void)applyKnobStyleFromConfig:(ghostty_config_t)config;
- (BOOL)debugScrollToFraction:(double)fraction;
@end

@implementation OrcaGhosttyScrollbarView {
  OrcaGhosttyScroller* _scroller;
  int64_t _lastRow;
  BOOL _syncing;
  BOOL _liveScrolling;
  BOOL _debugScrolling;
}

+ (instancetype)scrollbarOf:(OrcaGhosttySurfaceView*)surfaceView create:(BOOL)create {
  if (surfaceView == nil) return nil;
  for (NSView* subview in surfaceView.subviews) {
    if ([subview isKindOfClass:self]) return (OrcaGhosttyScrollbarView*)subview;
  }
  if (!create) return nil;
  OrcaGhosttyScrollbarView* scrollbar = [[self alloc] initWithFrame:NSZeroRect];
  scrollbar.surfaceView = surfaceView;
  SurfaceModel* model = surfaceView.model;
  [scrollbar applyKnobStyleFromConfig:model != nullptr && model->config != nullptr ? model->config : g_config];
  [surfaceView addSubview:scrollbar];
  [scrollbar pinToSuperviewEdge];
  return scrollbar;
}

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  _lastRow = -1;
  self.hidden = YES;
  self.drawsBackground = NO;
  self.borderType = NSNoBorder;
  self.hasHorizontalScroller = NO;
  _scroller = [[OrcaGhosttyScroller alloc] initWithFrame:NSZeroRect];
  self.verticalScroller = _scroller;
  self.hasVerticalScroller = YES;
  self.autohidesScrollers = NO;
  self.scrollerStyle = NSScrollerStyleOverlay;
  self.verticalScrollElasticity = NSScrollElasticityNone;
  // Full-size-content windows would otherwise inset a strip near the titlebar.
  self.automaticallyAdjustsContentInsets = NO;
  self.documentView = [[OrcaGhosttyScrollDocumentView alloc] initWithFrame:NSZeroRect];
  self.contentView.postsBoundsChangedNotifications = YES;
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  [center addObserver:self
             selector:@selector(clipViewDidScroll:)
                 name:NSViewBoundsDidChangeNotification
               object:self.contentView];
  [center addObserver:self
             selector:@selector(liveScrollWillStart:)
                 name:NSScrollViewWillStartLiveScrollNotification
               object:self];
  [center addObserver:self
             selector:@selector(liveScrollDidEnd:)
                 name:NSScrollViewDidEndLiveScrollNotification
               object:self];
  return self;
}

// Overlay even when System Settings asks for always-visible scroll bars: a legacy track
// would paint over the terminal's last column.
- (void)setScrollerStyle:(NSScrollerStyle)style {
  [super setScrollerStyle:NSScrollerStyleOverlay];
}

// Only the scroller takes the mouse; the rest of the strip is terminal underneath.
- (NSView*)hitTest:(NSPoint)point {
  NSView* hit = [super hitTest:point];
  NSScroller* scroller = self.verticalScroller;
  return hit != nil && scroller != nil && [hit isDescendantOf:scroller] ? hit : nil;
}

// The wheel stays Ghostty's (mouse reporting, momentum); the knob follows its viewport.
- (void)scrollWheel:(NSEvent*)event {
  [self.surfaceView scrollWheel:event];
}

- (void)resizeWithOldSuperviewSize:(NSSize)oldSize {
  [self pinToSuperviewEdge];
}

- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [self syncDocument];
}

- (void)pinToSuperviewEdge {
  NSView* superview = self.superview;
  if (superview == nil) return;
  const NSRect bounds = superview.bounds;
  const CGFloat width = MIN(NSWidth(bounds), [NSScroller scrollerWidthForControlSize:NSControlSizeRegular
                                                                       scrollerStyle:NSScrollerStyleOverlay]);
  self.frame = NSMakeRect(NSMaxX(bounds) - width, NSMinY(bounds), width, NSHeight(bounds));
}

- (void)applyKnobStyleFromConfig:(ghostty_config_t)config {
  ghostty_config_color_s background = {};
  const char* key = "background";
  if (config == nullptr || !ghostty_config_get(config, &background, key, strlen(key))) return;
  const double luma = (0.299 * background.r + 0.587 * background.g + 0.114 * background.b) / 255.0;
  self.scrollerKnobStyle = luma > 0.5 ? NSScrollerKnobStyleDark : NSScrollerKnobStyleLight;
}

- (BOOL)scrollable {
  return _len > 0 && _total > _len;
}

- (void)applyTotal:(uint64_t)total offset:(uint64_t)offset len:(uint64_t)len {
  const BOOL wasAtBottom = _offset + _len >= _total;
  const BOOL atBottom = offset + len >= total;
  // Output arriving at the bottom moves the offset too; only a viewport move flashes the knob.
  const BOOL moved = offset != _offset && !(wasAtBottom && atBottom);
  _total = total;
  _offset = offset;
  _len = len;
  self.hidden = ![self scrollable];
  if (self.hidden) return;
  [self syncDocument];
  if (moved && !_liveScrolling) [self flashScrollers];
}

- (void)syncDocument {
  if (_syncing || ![self scrollable]) return;
  NSClipView* clip = self.contentView;
  const CGFloat height = NSHeight(clip.bounds);
  if (height <= 0) return;
  const CGFloat rowHeight = height / static_cast<CGFloat>(_len);
  _syncing = YES;
  [self.documentView setFrameSize:NSMakeSize(NSWidth(clip.bounds), rowHeight * static_cast<CGFloat>(_total))];
  // Mid-drag the knob stays under the pointer; it settles on the row when the drag ends.
  if (!_liveScrolling) {
    [clip scrollToPoint:NSMakePoint(0, rowHeight * static_cast<CGFloat>(_offset))];
    _lastRow = static_cast<int64_t>(_offset);
  }
  [self reflectScrolledClipView:clip];
  _syncing = NO;
}

- (void)clipViewDidScroll:(NSNotification*)notification {
  // Resizes move the clip view too; only the user's scrolling may move Ghostty's viewport.
  const BOOL userScrolling = _scroller.tracking || _liveScrolling || _debugScrolling;
  if (_syncing || !userScrolling || ![self scrollable]) return;
  const CGFloat height = NSHeight(self.contentView.bounds);
  if (height <= 0) return;
  const double rows = NSMinY(self.contentView.bounds) / (height / static_cast<CGFloat>(_len));
  const auto row = static_cast<int64_t>(llround(MAX(0.0, MIN(rows, static_cast<double>(_total - _len)))));
  if (row == _lastRow) return;
  _lastRow = row;
  OrcaGhosttySurfaceView* surfaceView = self.surfaceView;
  ghostty_surface_t surface = surfaceView.model ? surfaceView.model->surface : nullptr;
  if (surface == nullptr) return;
  const std::string action = "scroll_to_row:" + std::to_string(row);
  ghostty_surface_binding_action(surface, action.c_str(), action.size());
}

- (void)liveScrollWillStart:(NSNotification*)notification {
  _liveScrolling = YES;
}

- (void)liveScrollDidEnd:(NSNotification*)notification {
  _liveScrolling = NO;
  [self syncDocument];
}

// What dragging the knob to `fraction` (0 top, 1 bottom) does, for headless tests.
- (BOOL)debugScrollToFraction:(double)fraction {
  if (![self scrollable]) return NO;
  NSClipView* clip = self.contentView;
  const CGFloat range = NSHeight(self.documentView.frame) - NSHeight(clip.bounds);
  _debugScrolling = YES;
  [clip scrollToPoint:NSMakePoint(0, MAX(0.0, MIN(1.0, fraction)) * MAX(0.0, range))];
  [self reflectScrolledClipView:clip];
  _debugScrolling = NO;
  return YES;
}

@end

@implementation OrcaGhosttySurfaceView (HostInput)

#pragma mark Host chords and pointer

- (void)forwardChordToHost:(NSEvent*)event {
  [self emitForwardedKey:event];
  if (_hostForwardedKeyCodes == nil) _hostForwardedKeyCodes = [NSMutableIndexSet indexSet];
  [_hostForwardedKeyCodes addIndex:event.keyCode];
  const NSEventModifierFlags held = event.modifierFlags & kChordModifiers;
  _hostHeldModifiers |= held;
  if (held == 0 || _hostModifierMonitor != nil) return;
  // Why a monitor: UI the chord opened (the Ctrl+Tab switcher) can hide this view and take the
  // keyboard, yet it still commits on the modifier's release.
  __weak OrcaGhosttySurfaceView* weakSelf = self;
  _hostModifierMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                               handler:^NSEvent*(NSEvent* flagsEvent) {
                                                                 [weakSelf hostModifiersChanged:flagsEvent];
                                                                 return flagsEvent;
                                                               }];
}

// The release of a key whose press went to Orca must not reach Ghostty as a stray release.
- (BOOL)consumeHostKeyUp:(NSEvent*)event {
  if (![_hostForwardedKeyCodes containsIndex:event.keyCode]) return NO;
  [_hostForwardedKeyCodes removeIndex:event.keyCode];
  return YES;
}

- (void)hostModifiersChanged:(NSEvent*)event {
  const NSEventModifierFlags released = _hostHeldModifiers & ~(event.modifierFlags & kChordModifiers);
  if (released == 0) return;
  _hostHeldModifiers &= ~released;
  if (_hostHeldModifiers == 0) [self endHostModifierTracking];
  // The web contents sees the release itself once it holds the keyboard again.
  id responder = self.window.firstResponder;
  if ([responder isKindOfClass:[NSView class]] && ![responder isKindOfClass:[OrcaGhosttySurfaceView class]]) return;
  for (NSEventModifierFlags flag : {NSEventModifierFlagShift, NSEventModifierFlagControl,
                                    NSEventModifierFlagOption, NSEventModifierFlagCommand}) {
    if ((released & flag) == 0) continue;
    auto* release = new SurfaceEvent{SurfaceEventKind::Key};
    release->a = ModifierKeyCode(flag, event.keyCode);
    release->b = static_cast<uint32_t>(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask);
    release->d = 1;
    Emit(self.model, release);
  }
}

- (void)endHostModifierTracking {
  _hostHeldModifiers = 0;
  if (_hostModifierMonitor == nil) return;
  id monitor = _hostModifierMonitor;
  _hostModifierMonitor = nil;
  // Removed outside the handler that may be running it.
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSEvent removeMonitor:monitor];
  });
}

- (void)emitMouseEntered:(NSEvent*)event {
  auto* entered = new SurfaceEvent{SurfaceEventKind::MouseEnter};
  entered->a = static_cast<uint32_t>(NSEvent.pressedMouseButtons);
  // Chromium reports the page unfocused while this view holds the keyboard, so say it here.
  entered->b = NSApp.isActive && self.window.isKeyWindow ? 1 : 0;
  Emit(self.model, entered);
}

// Orca's double-tap detectors watch DOM key events, which keys Ghostty takes never produce:
// report watched modifier taps, and every other key that breaks a tap, for main to detect.
- (void)reportDoubleTapInput:(NSEvent*)event {
  if (!g_double_tap_watch) return;
  const bool isModifier = event.type == NSEventTypeFlagsChanged;
  if (isModifier && !IsDoubleTapWatched(event.keyCode)) return;
  auto* input = new SurfaceEvent{SurfaceEventKind::DoubleTapInput};
  input->a = event.keyCode;
  input->b = static_cast<uint32_t>(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask);
  // 0 modifier press, 1 modifier release, 2 any other key going down.
  input->c = !isModifier ? 2 : (event.modifierFlags & ModifierFlagForKeyCode(event.keyCode)) != 0 ? 0 : 1;
  Emit(self.model, input);
}

@end

@implementation OrcaGhosttySurfaceView (TextServices)

#pragma mark Services menu

- (id)validRequestorForSendType:(NSPasteboardType)sendType returnType:(NSPasteboardType)returnType {
  const BOOL sendsText = sendType == nil || [sendType isEqualToString:NSPasteboardTypeString];
  const BOOL takesText = returnType == nil || [returnType isEqualToString:NSPasteboardTypeString];
  const BOOL hasSelection = self.surface && ghostty_surface_has_selection(self.surface);
  if ((sendType != nil || returnType != nil) && sendsText && takesText && (sendType == nil || hasSelection)) {
    return self;
  }
  return [super validRequestorForSendType:sendType returnType:returnType];
}

- (BOOL)writeSelectionToPasteboard:(NSPasteboard*)pboard types:(NSArray<NSPasteboardType>*)types {
  if (!self.surface) return NO;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(self.surface, &text)) return NO;
  NSString* selection = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding];
  ghostty_surface_free_text(self.surface, &text);
  if (selection == nil) return NO;
  [pboard declareTypes:@[ NSPasteboardTypeString ] owner:nil];
  return [pboard setString:selection forType:NSPasteboardTypeString];
}

// A service's result is pasted through Orca's terminal paste pipeline, like Edit > Paste.
- (BOOL)readSelectionFromPasteboard:(NSPasteboard*)pboard {
  NSString* text = [pboard stringForType:NSPasteboardTypeString];
  if (text == nil) return NO;
  if (text.length == 0) return YES;
  auto* paste = new SurfaceEvent{SurfaceEventKind::ServicePaste};
  paste->text = text.UTF8String ?: "";
  Emit(self.model, paste);
  return YES;
}

@end

@implementation OrcaGhosttySurfaceView (Accessibility)

#pragma mark Accessibility

- (NSString*)accessibilityText {
  const CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (_accessibilityText == nil || now - _accessibilityTextTime > 0.5) {
    _accessibilityText = ReadViewportText(self.surface);
    _accessibilityTextTime = now;
  }
  return _accessibilityText;
}

- (BOOL)isAccessibilityElement {
  return YES;
}

- (NSAccessibilityRole)accessibilityRole {
  return NSAccessibilityTextAreaRole;
}

- (NSString*)accessibilityLabel {
  // The renderer sets the label in Orca's UI language at creation.
  return [super accessibilityLabel] ?: @"Terminal";
}

- (id)accessibilityValue {
  return [self accessibilityText];
}

- (NSInteger)accessibilityNumberOfCharacters {
  return static_cast<NSInteger>([self accessibilityText].length);
}

- (NSRange)accessibilityVisibleCharacterRange {
  return NSMakeRange(0, [self accessibilityText].length);
}

- (NSString*)accessibilitySelectedText {
  if (!self.surface) return nil;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(self.surface, &text)) return nil;
  NSString* selection = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding];
  ghostty_surface_free_text(self.surface, &text);
  return selection.length > 0 ? selection : nil;
}

// No selection reads as a caret after the visible text, never NSNotFound.
- (NSRange)accessibilitySelectedTextRange {
  const NSRange range = [self selectedRange];
  return range.location == NSNotFound ? NSMakeRange([self accessibilityText].length, 0) : range;
}

- (NSInteger)accessibilityLineForIndex:(NSInteger)index {
  NSString* text = [self accessibilityText];
  const NSUInteger end = MIN(static_cast<NSUInteger>(MAX(index, 0)), text.length);
  NSInteger line = 0;
  for (NSUInteger i = 0; i < end; i++) {
    if ([text characterAtIndex:i] == '\n') line++;
  }
  return line;
}

- (NSRange)accessibilityRangeForLine:(NSInteger)line {
  NSString* text = [self accessibilityText];
  __block NSInteger current = 0;
  __block NSRange found = NSMakeRange(NSNotFound, 0);
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length)
                           options:NSStringEnumerationByLines
                        usingBlock:^(NSString*, NSRange, NSRange enclosingRange, BOOL* stop) {
                          if (current++ == line) {
                            found = enclosingRange;
                            *stop = YES;
                          }
                        }];
  return found;
}

- (NSString*)accessibilityStringForRange:(NSRange)range {
  NSString* text = [self accessibilityText];
  if (range.location == NSNotFound || range.location > text.length) return nil;
  return [text substringWithRange:NSMakeRange(range.location, MIN(range.length, text.length - range.location))];
}

// Assistive input (Voice Control, AX-driven dictation) types at the prompt like the keyboard.
- (void)setAccessibilitySelectedText:(NSString*)text {
  if ([text isKindOfClass:[NSString class]] && text.length > 0) {
    [self committedTextAction:GHOSTTY_ACTION_PRESS text:text];
  }
}

// A terminal cannot rewrite its screen; a new value that extends the old one types the rest.
- (void)setAccessibilityValue:(id)value {
  NSString* current = ReadViewportText(self.surface);
  if (![value isKindOfClass:[NSString class]] || ![value hasPrefix:current]) return;
  NSString* added = [value substringFromIndex:current.length];
  if (added.length > 0) [self committedTextAction:GHOSTTY_ACTION_PRESS text:added];
}

- (BOOL)isAccessibilitySelectorAllowed:(SEL)selector {
  if (selector == @selector(setAccessibilitySelectedText:) || selector == @selector(setAccessibilityValue:)) {
    return YES;
  }
  return [super isAccessibilitySelectorAllowed:selector];
}

- (void)accessibilitySelectionChanged {
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(postAccessibilitySelectionChanged) object:nil];
  [self performSelector:@selector(postAccessibilitySelectionChanged) withObject:nil afterDelay:0.1];
}

- (void)postAccessibilitySelectionChanged {
  _accessibilityText = nil;
  NSAccessibilityPostNotification(self, NSAccessibilitySelectedTextChangedNotification);
}

@end

#pragma mark Secure keyboard entry

// Ghostty's lock, shown on the surface while Secure Keyboard Entry guards its password prompt.
@interface OrcaGhosttySecureInputBadge : NSImageView
@end

@implementation OrcaGhosttySecureInputBadge
- (NSView*)hitTest:(NSPoint)point {
  return nil;
}
@end

// A file drag for debugDrop, standing in for the session AppKit would hand a destination.
@interface OrcaDebugDraggingInfo : NSObject <NSDraggingInfo>
@property(nonatomic, strong) NSPasteboard* pasteboard;
@property(nonatomic, weak) NSWindow* window;
@property(nonatomic, assign) NSPoint location;
@end

@implementation OrcaDebugDraggingInfo
@synthesize draggingFormation = _draggingFormation;
@synthesize animatesToDestination = _animatesToDestination;
@synthesize numberOfValidItemsForDrop = _numberOfValidItemsForDrop;

- (NSWindow*)draggingDestinationWindow {
  return self.window;
}
- (NSDragOperation)draggingSourceOperationMask {
  return NSDragOperationCopy | NSDragOperationLink | NSDragOperationGeneric;
}
- (NSPoint)draggingLocation {
  return self.location;
}
- (NSPoint)draggedImageLocation {
  return self.location;
}
- (NSImage*)draggedImage {
  return nil;
}
- (NSPasteboard*)draggingPasteboard {
  return self.pasteboard;
}
- (id)draggingSource {
  return nil;
}
- (NSInteger)draggingSequenceNumber {
  return 1;
}
- (void)slideDraggedImageTo:(NSPoint)screenPoint {
}
- (NSArray<NSString*>*)namesOfPromisedFilesDroppedAtDestination:(NSURL*)dropDestination {
  return nil;
}
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)enumOpts
                                  forView:(NSView*)view
                                  classes:(NSArray<Class>*)classArray
                            searchOptions:(NSDictionary<NSPasteboardReadingOptionKey, id>*)searchOptions
                               usingBlock:(void (^)(NSDraggingItem*, NSInteger, BOOL*))block {
}
- (NSSpringLoadingHighlight)springLoadingHighlight {
  return NSSpringLoadingHighlightNone;
}
- (void)resetSpringLoading {
}
@end

namespace {

#pragma mark Secure keyboard entry (state)

// The one EnableSecureEventInput this process may hold: a stuck one blinds every keyboard
// monitor on the system, so a single owner, like Ghostty's, and every exit path drops it.
bool g_secure_input_on = false;
// Debug only: drive the state machine without touching the system-wide flag.
bool g_secure_input_simulated = false;
int32_t g_secure_input_owner = 0;
dispatch_source_t g_termios_timer = nil;
NSMutableDictionary<NSNumber*, NSString*>* g_tty_paths = nil;
bool g_secure_input_observed = false;

// Ghostty's heuristic: a canonical-mode read with echo off is a password prompt.
bool TtyReadsPassword(NSString* path) {
  const int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct termios mode = {};
  const bool read = isatty(fd) && tcgetattr(fd, &mode) == 0;
  close(fd);
  return read && (mode.c_lflag & ICANON) != 0 && (mode.c_lflag & ECHO) == 0;
}

// The controlling terminal of a local process (the pane's root), as a device path. sysctl, not
// proc_pidinfo: that root is often the setuid /usr/bin/login, which proc_pidinfo won't describe.
NSString* TtyOfProcess(pid_t pid) {
  struct kinfo_proc info = {};
  size_t size = sizeof(info);
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  if (pid <= 0 || sysctl(mib, 4, &info, &size, nullptr, 0) != 0 || size != sizeof(info)) return nil;
  if (info.kp_eproc.e_tdev == NODEV) return nil;
  const char* name = devname(info.kp_eproc.e_tdev, S_IFCHR);
  return name ? [@"/dev/" stringByAppendingString:@(name)] : nil;
}

// The surface that takes typed keys right now: first responder of the key, active window.
OrcaGhosttySurfaceView* KeyboardOwnerSurface() {
  for (OrcaGhosttySurfaceView* view in g_views.allValues) {
    NSWindow* window = view.window;
    if (window == nil || view.hidden || window.firstResponder != view) continue;
    if (g_secure_input_simulated || (window.isKeyWindow && NSApp.isActive)) return view;
  }
  return nil;
}

void SetSecureInput(bool on) {
  if (on == g_secure_input_on) return;
  if (g_secure_input_simulated) {
    g_secure_input_on = on;
    return;
  }
  if ((on ? EnableSecureEventInput() : DisableSecureEventInput()) == noErr) g_secure_input_on = on;
}

OrcaGhosttySecureInputBadge* SecureInputBadgeOf(NSView* view) {
  for (NSView* subview in view.subviews) {
    if ([subview isKindOfClass:[OrcaGhosttySecureInputBadge class]]) return (OrcaGhosttySecureInputBadge*)subview;
  }
  return nil;
}

void ShowSecureInputBadge(OrcaGhosttySurfaceView* view, bool shown) {
  OrcaGhosttySecureInputBadge* badge = SecureInputBadgeOf(view);
  if (!shown || badge != nil) {
    if (!shown) [badge removeFromSuperview];
    return;
  }
  // Top-right, clear of the overlay scroller.
  const CGFloat size = 18;
  const NSRect bounds = view.bounds;
  badge = [[OrcaGhosttySecureInputBadge alloc]
      initWithFrame:NSMakeRect(NSMaxX(bounds) - size - 20, NSMaxY(bounds) - size - 8, size, size)];
  badge.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
  badge.image = [NSImage imageWithSystemSymbolName:@"lock.shield.fill"
                          accessibilityDescription:@"Secure Keyboard Entry is on"];
  badge.contentTintColor = NSColor.controlAccentColor;
  [view addSubview:badge];
}

void StopTermiosPoll() {
  if (g_termios_timer == nil) return;
  dispatch_source_cancel(g_termios_timer);
  g_termios_timer = nil;
}

void UpdateSecureInput() {
  OrcaGhosttySurfaceView* owner = KeyboardOwnerSurface();
  // Like Ghostty's app: only the keyboard owner of the key window is focused, so other panes
  // and a backgrounded Orca stop the cursor timer that redraws every 600 ms.
  for (OrcaGhosttySurfaceView* view in g_views.allValues) {
    [view setGhosttyFocused:view == owner && view.keyboardFocused];
  }
  NSString* tty = owner.model ? g_tty_paths[@(owner.model->id)] : nil;
  SetSecureInput(tty != nil && TtyReadsPassword(tty));
  g_secure_input_owner = g_secure_input_on && owner.model ? owner.model->id : 0;
  for (OrcaGhosttySurfaceView* view in g_views.allValues) {
    ShowSecureInputBadge(view, view.model != nullptr && view.model->id == g_secure_input_owner);
  }
  // Like Ghostty: poll termios every 200 ms, only while a surface with a known tty has the keys.
  if (tty == nil) {
    StopTermiosPoll();
    return;
  }
  if (g_termios_timer != nil) return;
  g_termios_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(g_termios_timer, dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC),
                            200 * NSEC_PER_MSEC, 20 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(g_termios_timer, ^{
    UpdateSecureInput();
  });
  dispatch_resume(g_termios_timer);
}

void ObserveWindowState() {
  if (g_secure_input_observed) return;
  g_secure_input_observed = true;
  // Synchronous (nil queue): deactivating the app must drop secure input before anything else runs.
  for (NSNotificationName name in @[ NSApplicationDidResignActiveNotification, NSApplicationDidBecomeActiveNotification,
                                     NSWindowDidResignKeyNotification, NSWindowDidBecomeKeyNotification ]) {
    [NSNotificationCenter.defaultCenter addObserverForName:name
                                                    object:nil
                                                     queue:nil
                                                usingBlock:^(NSNotification*) {
                                                  UpdateSecureInput();
                                                }];
  }
  // Like Ghostty's app: an occluded window's surfaces stop drawing and release their swap chains.
  [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification
                                                  object:nil
                                                   queue:nil
                                              usingBlock:^(NSNotification* note) {
                                                for (OrcaGhosttySurfaceView* view in g_views.allValues) {
                                                  if (view.window == note.object) [view syncGhosttyVisible];
                                                }
                                              }];
}

}  // namespace

namespace {

#pragma mark Runtime callbacks

OrcaGhosttySurfaceView* ViewForSurfaceUserdata(void* userdata) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr) return nil;
  return g_views[@(model->id)];
}

SurfaceModel* ModelForTarget(ghostty_target_s target) {
  if (target.tag != GHOSTTY_TARGET_SURFACE || target.target.surface == nullptr) return nullptr;
  return static_cast<SurfaceModel*>(ghostty_surface_userdata(target.target.surface));
}

void OnWakeup(void*) {
  ScheduleTick();
}

bool OnAction(ghostty_app_t, ghostty_target_s target, ghostty_action_s action) {
  SurfaceModel* model = ModelForTarget(target);
  switch (action.tag) {
    case GHOSTTY_ACTION_SET_TITLE: {
      if (!model || !action.action.set_title.title) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::Title};
      event->text = action.action.set_title.title;
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_PWD: {
      if (!model || !action.action.pwd.pwd) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::Pwd};
      event->text = action.action.pwd.pwd;
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_OPEN_URL: {
      if (!model || !action.action.open_url.url) return false;
      auto* event = new SurfaceEvent{SurfaceEventKind::OpenUrl};
      event->text.assign(action.action.open_url.url, action.action.open_url.len);
      Emit(model, event);
      return true;
    }
    case GHOSTTY_ACTION_SELECTION_CHANGED: {
      if (!model) return false;
      [ViewForSurfaceUserdata(model) accessibilitySelectionChanged];
      return true;
    }
    case GHOSTTY_ACTION_RING_BELL: {
      if (!model) return false;
      Emit(model, new SurfaceEvent{SurfaceEventKind::Bell});
      return true;
    }
    case GHOSTTY_ACTION_MOUSE_SHAPE: {
      NSCursor* cursor = NSCursor.arrowCursor;
      switch (action.action.mouse_shape) {
        case GHOSTTY_MOUSE_SHAPE_TEXT: cursor = NSCursor.IBeamCursor; break;
        case GHOSTTY_MOUSE_SHAPE_POINTER: cursor = NSCursor.pointingHandCursor; break;
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR: cursor = NSCursor.crosshairCursor; break;
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED: cursor = NSCursor.operationNotAllowedCursor; break;
        default: break;
      }
      [cursor set];
      return true;
    }
    case GHOSTTY_ACTION_SCROLLBAR: {
      OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(model);
      if (view == nil) return false;
      const ghostty_action_scrollbar_s& bar = action.action.scrollbar;
      [[OrcaGhosttyScrollbarView scrollbarOf:view create:YES] applyTotal:bar.total offset:bar.offset len:bar.len];
      return true;
    }
    case GHOSTTY_ACTION_CONFIG_CHANGE: {
      OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(model);
      [[OrcaGhosttyScrollbarView scrollbarOf:view create:NO]
          applyKnobStyleFromConfig:action.action.config_change.config];
      return view != nil;
    }
    default:
      return false;
  }
}

ghostty_clipboard_read_result_e OnReadClipboard(void* userdata, ghostty_clipboard_e location, void* state,
                                                const char* const* mimes, size_t mimes_len, bool list) {
  OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(userdata);
  if (view == nil || view.model->surface == nullptr || location != GHOSTTY_CLIPBOARD_STANDARD) {
    return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED;
  }
  NSString* string = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
  if (string == nil) return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE;
  const char* utf8 = string.UTF8String;
  ghostty_clipboard_content_s content = {"text/plain", utf8, strlen(utf8)};
  const char* available[] = {"text/plain"};
  ghostty_clipboard_complete_s complete = {};
  complete.contents = &content;
  complete.contents_len = 1;
  complete.available = list ? available : nullptr;
  complete.available_len = list ? 1 : 0;
  complete.confirmed = true;
  ghostty_surface_complete_clipboard_request(view.model->surface, &complete, state);
  return GHOSTTY_CLIPBOARD_READ_STARTED;
}

void OnConfirmReadClipboard(void* userdata, const ghostty_clipboard_confirm_s*, void* state,
                            ghostty_clipboard_request_e) {
  // OSC 52 reads are Orca's call; the shadow emulator already answers them.
  OrcaGhosttySurfaceView* view = ViewForSurfaceUserdata(userdata);
  if (view != nil && view.model->surface) ghostty_surface_deny_clipboard_request(view.model->surface, state);
}

void OnWriteClipboard(void*, ghostty_clipboard_e location, const ghostty_clipboard_content_s* contents,
                      size_t len, bool) {
  if (location != GHOSTTY_CLIPBOARD_STANDARD) return;
  for (size_t i = 0; i < len; i++) {
    if (contents[i].mime && strcmp(contents[i].mime, "text/plain") == 0 && contents[i].data) {
      NSString* text = [[NSString alloc] initWithBytes:contents[i].data
                                                length:contents[i].len
                                              encoding:NSUTF8StringEncoding];
      if (text == nil) return;
      [NSPasteboard.generalPasteboard clearContents];
      [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
      return;
    }
  }
}

void OnCloseSurface(void*, bool) {
  // The daemon owns the process; closing a pane goes through Orca.
}

bool IsFocusReport(const uint8_t* bytes, size_t len) {
  return len == 3 && bytes[0] == 0x1b && bytes[1] == '[' && (bytes[2] == 'I' || bytes[2] == 'O');
}

void OnReceiveBuffer(void* userdata, const uint8_t* bytes, size_t len) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr || len == 0) return;
  if (IsFocusReport(bytes, len)) {
    int pending = model->swallowed_focus_reports.load();
    while (pending > 0 && !model->swallowed_focus_reports.compare_exchange_weak(pending, pending - 1)) {
    }
    if (pending > 0) return;
  }
  auto* event = new SurfaceEvent{SurfaceEventKind::Input};
  event->text.assign(reinterpret_cast<const char*>(bytes), len);
  Emit(model, event);
}

void OnReceiveResize(void* userdata, uint16_t cols, uint16_t rows, uint32_t width, uint32_t height) {
  auto* model = static_cast<SurfaceModel*>(userdata);
  if (model == nullptr) return;
  auto* event = new SurfaceEvent{SurfaceEventKind::Resize};
  event->a = cols;
  event->b = rows;
  event->c = width;
  event->d = height;
  Emit(model, event);
}

#pragma mark N-API helpers

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Bool(napi_env env, bool b) {
  napi_value value;
  napi_get_boolean(env, b, &value);
  return value;
}

napi_value Number(napi_env env, double n) {
  napi_value value;
  napi_create_double(env, n, &value);
  return value;
}

napi_value String(napi_env env, const std::string& s) {
  napi_value value;
  napi_create_string_utf8(env, s.data(), s.size(), &value);
  return value;
}

bool ThrowIf(napi_env env, bool failed, const char* message) {
  if (failed) napi_throw_error(env, nullptr, message);
  return failed;
}

double GetDouble(napi_env env, napi_value value) {
  double d = 0;
  napi_get_value_double(env, value, &d);
  return d;
}

int32_t GetInt(napi_env env, napi_value value) {
  int32_t i = 0;
  napi_get_value_int32(env, value, &i);
  return i;
}

bool GetBool(napi_env env, napi_value value) {
  bool b = false;
  napi_get_value_bool(env, value, &b);
  return b;
}

std::string GetString(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, value, s.data(), len + 1, &len);
  return s;
}

OrcaGhosttySurfaceView* ViewForId(int32_t id) {
  return g_views[@(id)];
}

void CallJs(napi_env env, napi_value callback, void*, void* data) {
  auto* event = static_cast<SurfaceEvent*>(data);
  if (env != nullptr && callback != nullptr) {
    napi_value argv[6];
    size_t argc = 1;
    switch (event->kind) {
      case SurfaceEventKind::Input: {
        argv[0] = String(env, "input");
        void* out = nullptr;
        napi_create_buffer_copy(env, event->text.size(), event->text.data(), &out, &argv[1]);
        argc = 2;
        break;
      }
      case SurfaceEventKind::Resize:
        argv[0] = String(env, "resize");
        argv[1] = Number(env, event->a);
        argv[2] = Number(env, event->b);
        argv[3] = Number(env, event->c);
        argv[4] = Number(env, event->d);
        argc = 5;
        break;
      case SurfaceEventKind::Focus:
        argv[0] = String(env, "focus");
        argv[1] = Bool(env, event->a != 0);
        argc = 2;
        break;
      case SurfaceEventKind::Key:
        argv[0] = String(env, "key");
        argv[1] = String(env, event->text);
        argv[2] = Number(env, event->a);
        argv[3] = Number(env, event->b);
        argv[4] = Bool(env, event->c != 0);
        // A modifier's release after a forwarded chord: keyup only.
        argv[5] = Bool(env, event->d != 0);
        argc = 6;
        break;
      case SurfaceEventKind::Title:
        argv[0] = String(env, "title");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::Pwd:
        argv[0] = String(env, "pwd");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::OpenUrl:
        argv[0] = String(env, "openUrl");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
      case SurfaceEventKind::Bell:
        argv[0] = String(env, "bell");
        break;
      case SurfaceEventKind::MouseShape:
        argv[0] = String(env, "mouseShape");
        break;
      case SurfaceEventKind::ContextMenu:
        argv[0] = String(env, "contextMenu");
        argv[1] = Number(env, event->a);
        argv[2] = Number(env, event->b);
        argc = 3;
        break;
      case SurfaceEventKind::MouseEnter:
        argv[0] = String(env, "mouseEnter");
        argv[1] = Number(env, event->a);
        argv[2] = Bool(env, event->b != 0);
        argc = 3;
        break;
      case SurfaceEventKind::DoubleTapInput:
        argv[0] = String(env, "doubleTapInput");
        argv[1] = Number(env, event->a);
        argv[2] = Number(env, event->b);
        argv[3] = Number(env, event->c);
        argc = 4;
        break;
      case SurfaceEventKind::ServicePaste:
        argv[0] = String(env, "servicePaste");
        argv[1] = String(env, event->text);
        argc = 2;
        break;
    }
    napi_value global;
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, argc, argv, nullptr);
  }
  delete event;
}

ghostty_config_t LoadConfig(const std::string& path) {
  ghostty_config_t config = ghostty_config_new();
  // The user's own Ghostty config is deliberately not loaded: Orca's settings drive the surface.
  if (!path.empty()) ghostty_config_load_file(config, path.c_str());
  ghostty_config_finalize(config);
  const uint32_t diagnostics = ghostty_config_diagnostics_count(config);
  for (uint32_t i = 0; i < diagnostics; i++) {
    ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(config, i);
    NSLog(@"[orca-ghostty] config: %s", diag.message);
  }
  return config;
}

OrcaGhosttyHostView* HostViewForWindowHandle(napi_env env, napi_value handle) {
  void* data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, handle, &data, &len) != napi_ok || len < sizeof(void*)) return nil;
  void* raw = nullptr;
  memcpy(&raw, data, sizeof(void*));
  NSView* contentView = (__bridge NSView*)raw;
  if (contentView == nil || contentView.window == nil) return nil;
  for (NSView* subview in contentView.subviews) {
    if ([subview isKindOfClass:[OrcaGhosttyHostView class]]) return (OrcaGhosttyHostView*)subview;
  }
  OrcaGhosttyHostView* host = [[OrcaGhosttyHostView alloc] initWithFrame:contentView.bounds];
  host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // Chromium keeps views it does not own above web contents; see native_widget_ns_window_bridge.mm.
  [contentView addSubview:host positioned:NSWindowAbove relativeTo:nil];
  return host;
}

// Hands the keyboard to the web contents under a surface (hidden, or another pane took DOM
// focus), so the page gets typed keys instead of the surface or the bare window.
void ReturnKeyboardToWebContents(OrcaGhosttySurfaceView* view) {
  NSWindow* window = view.window;
  NSView* content = window.contentView;
  const NSPoint center = [view convertPoint:NSMakePoint(NSMidX(view.bounds), NSMidY(view.bounds)) toView:content];
  NSView* target = nil;
  // Skip the host view that holds every surface: what lies under it is Chromium's view.
  for (NSView* subview in content.subviews.reverseObjectEnumerator) {
    if ([subview isKindOfClass:[OrcaGhosttyHostView class]]) continue;
    target = [subview hitTest:center];
    if (target != nil) break;
  }
  while (target != nil && !target.acceptsFirstResponder) target = target.superview;
  [window makeFirstResponder:target];
}

#pragma mark Exports

// init(configPath?: string): boolean
napi_value Init(napi_env env, napi_callback_info info) {
  if (g_app != nullptr) return Bool(env, true);
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string path = argc > 0 ? GetString(env, argv[0]) : "";

  static char arg0[] = "orca";
  static char* args[] = {arg0, nullptr};
  if (ghostty_init(1, args) != 0) return Bool(env, false);

  g_config = LoadConfig(path);
  ghostty_runtime_config_s runtime = {};
  runtime.userdata = nullptr;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = OnWakeup;
  runtime.action_cb = OnAction;
  runtime.read_clipboard_cb = OnReadClipboard;
  runtime.confirm_read_clipboard_cb = OnConfirmReadClipboard;
  runtime.write_clipboard_cb = OnWriteClipboard;
  runtime.close_surface_cb = OnCloseSurface;
  g_app = ghostty_app_new(&runtime, g_config);
  if (g_app == nullptr) return Bool(env, false);
  g_views = [NSMutableDictionary dictionary];
  g_tty_paths = [NSMutableDictionary dictionary];
  g_shown_windows = [NSHashTable weakObjectsHashTable];
  ObserveWindowState();
  // Services hand surfaces their selection and take text back (validRequestorForSendType).
  [NSApp registerServicesMenuSendTypes:@[ NSPasteboardTypeString ] returnTypes:@[ NSPasteboardTypeString ]];
  ghostty_app_set_focus(g_app, NSApp.isActive);
  return Bool(env, true);
}

// updateConfig(configPath: string): void
napi_value UpdateConfig(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (ThrowIf(env, g_app == nullptr || argc < 1, "ghostty not initialized")) return nullptr;
  ghostty_config_t next = LoadConfig(GetString(env, argv[0]));
  ghostty_app_update_config(g_app, next);
  for (OrcaGhosttySurfaceView* view in g_views.allValues) {
    if (view.model->surface && view.model->config == nullptr) ghostty_surface_update_config(view.model->surface, next);
  }
  if (g_config) ghostty_config_free(g_config);
  g_config = next;
  return Undefined(env);
}

// updateSurfaceConfig(id, configPath: string): void — the surface keeps this config across app updates.
napi_value UpdateSurfaceConfig(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (ThrowIf(env, g_app == nullptr || argc < 2, "ghostty not initialized")) return nullptr;
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.model->surface == nullptr) return Undefined(env);
  ghostty_config_t next = LoadConfig(GetString(env, argv[1]));
  ghostty_surface_update_config(view.model->surface, next);
  if (view.model->config) ghostty_config_free(view.model->config);
  view.model->config = next;
  return Undefined(env);
}

// createSurface(windowHandle: Buffer, x, y, width, height, onEvent): number
napi_value CreateSurface(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (ThrowIf(env, g_app == nullptr, "ghostty not initialized")) return nullptr;
  if (ThrowIf(env, argc < 6, "createSurface(handle, x, y, width, height, onEvent)")) return nullptr;
  OrcaGhosttyHostView* host = HostViewForWindowHandle(env, argv[0]);
  if (ThrowIf(env, host == nil, "invalid native window handle")) return nullptr;

  NSRect frame = NSMakeRect(GetDouble(env, argv[1]), GetDouble(env, argv[2]), GetDouble(env, argv[3]),
                            GetDouble(env, argv[4]));
  auto* model = new SurfaceModel();
  model->id = g_next_id.fetch_add(1);

  napi_value name = String(env, "orca-ghostty-surface");
  if (napi_create_threadsafe_function(env, argv[5], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs,
                                      &model->events) != napi_ok) {
    delete model;
    napi_throw_error(env, nullptr, "failed to create event channel");
    return nullptr;
  }
  // Event delivery must not keep Electron's main loop alive on quit.
  napi_unref_threadsafe_function(env, model->events);

  OrcaGhosttySurfaceView* view = [[OrcaGhosttySurfaceView alloc] initWithFrame:frame];
  view.model = model;
  [host addSubview:view];

  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void*)view;
  config.userdata = model;
  config.backend = GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED;
  config.receive_userdata = model;
  config.receive_buffer = OnReceiveBuffer;
  config.receive_resize = OnReceiveResize;
  config.scale_factor = host.window.backingScaleFactor;
  config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
  model->surface = ghostty_surface_new(g_app, &config);
  if (model->surface == nullptr) {
    [view removeFromSuperview];
    napi_release_threadsafe_function(model->events, napi_tsfn_abort);
    delete model;
    napi_throw_error(env, nullptr, "ghostty_surface_new failed");
    return nullptr;
  }
  g_views[@(model->id)] = view;
  [view observePresentedFrames];
  [view setGhosttyFocused:NO];
  [view viewDidChangeBackingProperties];
  ScheduleTick();
  return Number(env, model->id);
}

// writeOutput(id, data: Buffer): void
napi_value WriteOutput(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.model->surface == nullptr) return Undefined(env);
  void* data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[1], &data, &len) == napi_ok && len > 0) {
    [view noteOutput];
    ghostty_surface_write_buffer_replay(view.model->surface, static_cast<const uint8_t*>(data), len);
  }
  return Undefined(env);
}

// The optional 7th frame field: [[x, y, width, height], ...] in host (window) points.
NSArray<NSValue*>* HolesForFrame(napi_env env, napi_value entry, OrcaGhosttySurfaceView* view) {
  uint32_t length = 0;
  if (napi_get_array_length(env, entry, &length) != napi_ok || length < 7) return nil;
  napi_value list;
  uint32_t count = 0;
  napi_get_element(env, entry, 6, &list);
  if (napi_get_array_length(env, list, &count) != napi_ok) return nil;
  NSMutableArray<NSValue*>* holes = [NSMutableArray arrayWithCapacity:count];
  for (uint32_t i = 0; i < count; i++) {
    napi_value hole;
    napi_value parts[4];
    napi_get_element(env, list, i, &hole);
    for (uint32_t k = 0; k < 4; k++) napi_get_element(env, hole, k, &parts[k]);
    const NSRect inHost = NSMakeRect(GetDouble(env, parts[0]), GetDouble(env, parts[1]), GetDouble(env, parts[2]),
                                     GetDouble(env, parts[3]));
    [holes addObject:[NSValue valueWithRect:[view convertRect:inHost fromView:view.superview]]];
  }
  return holes;
}

// setFrames(frames: Array<[id, x, y, width, height, visible, holes?]>): void
napi_value SetFrames(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t count = 0;
  if (argc < 1 || napi_get_array_length(env, argv[0], &count) != napi_ok) return Undefined(env);
  g_set_frames_count++;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    napi_get_element(env, argv[0], i, &entry);
    napi_value fields[6];
    for (uint32_t f = 0; f < 6; f++) napi_get_element(env, entry, f, &fields[f]);
    OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, fields[0]));
    if (view == nil) continue;
    const bool visible = GetBool(env, fields[5]);
    if (visible) {
      view.frame = NSMakeRect(GetDouble(env, fields[1]), GetDouble(env, fields[2]), GetDouble(env, fields[3]),
                              GetDouble(env, fields[4]));
    }
    if (view.hidden == visible) {
      // Read first: hiding a first responder already hands the keyboard to the bare window.
      const bool hadKeyboard = view.window.firstResponder == view;
      view.hidden = !visible;
      [view syncGhosttyVisible];
      if (!visible && hadKeyboard) ReturnKeyboardToWebContents(view);
    }
    [view setOverlayHoles:visible ? HolesForFrame(env, entry, view) : nil];
  }
  [CATransaction commit];
  return Undefined(env);
}

// focus(id): void
napi_value Focus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view != nil && !view.hidden && view.window.firstResponder != view) [view.window makeFirstResponder:view];
  return Undefined(env);
}

// setAppFocus(focused: boolean): void
napi_value SetAppFocus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (g_app) ghostty_app_set_focus(g_app, GetBool(env, argv[0]));
  return Undefined(env);
}

// performAction(id, action): boolean — a Ghostty binding action such as "copy_to_clipboard".
napi_value PerformAction(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.model->surface == nullptr) return Bool(env, false);
  const std::string action = GetString(env, argv[1]);
  return Bool(env, ghostty_surface_binding_action(view.model->surface, action.c_str(), action.size()));
}

// readSelection(id): string | null
napi_value ReadSelection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection(view.model->surface, &text)) return result;
  result = String(env, std::string(text.text, text.text_len));
  ghostty_surface_free_text(view.model->surface, &text);
  return result;
}

// gridSize(id): { columns, rows, cellWidth, cellHeight } | null
napi_value GridSize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  ghostty_surface_size_s size = ghostty_surface_size(view.model->surface);
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "columns", Number(env, size.columns));
  napi_set_named_property(env, result, "rows", Number(env, size.rows));
  napi_set_named_property(env, result, "cellWidth", Number(env, size.cell_width_px));
  napi_set_named_property(env, result, "cellHeight", Number(env, size.cell_height_px));
  return result;
}

// processExit(id, exitCode): void
napi_value ProcessExit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view != nil && view.model->surface) {
    ghostty_surface_process_exit(view.model->surface, static_cast<uint32_t>(GetInt(env, argv[1])), 0);
  }
  return Undefined(env);
}

// destroySurface(id): void
napi_value DestroySurface(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int32_t id = GetInt(env, argv[0]);
  OrcaGhosttySurfaceView* view = ViewForId(id);
  if (view == nil) return Undefined(env);
  SurfaceModel* model = view.model;
  model->closed = true;
  [view endHostModifierTracking];
  if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
  [view removeFromSuperview];
  [g_views removeObjectForKey:@(id)];
  [g_tty_paths removeObjectForKey:@(id)];
  UpdateSecureInput();
  [view stopObservingPresentedFrames];
  if (model->surface) ghostty_surface_free(model->surface);
  model->surface = nullptr;
  if (model->config) ghostty_config_free(model->config);
  model->config = nullptr;
  view.model = nullptr;
  napi_release_threadsafe_function(model->events, napi_tsfn_abort);
  delete model;
  return Undefined(env);
}

// debugKey(id, characters, keyCode, modifierFlags): void — synthetic keyDown+keyUp for headless tests.
napi_value DebugKey(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil) return Undefined(env);
  NSString* chars = [NSString stringWithUTF8String:GetString(env, argv[1]).c_str()];
  const auto keyCode = static_cast<unsigned short>(GetInt(env, argv[2]));
  const auto flags = static_cast<NSEventModifierFlags>(GetInt(env, argv[3]));
  for (NSEventType type : {NSEventTypeKeyDown, NSEventTypeKeyUp}) {
    NSEvent* event = [NSEvent keyEventWithType:type
                                      location:NSZeroPoint
                                 modifierFlags:flags
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:view.window.windowNumber
                                       context:nil
                                    characters:chars
                   charactersIgnoringModifiers:chars
                                     isARepeat:NO
                                       keyCode:keyCode];
    if (type == NSEventTypeKeyDown) [view keyDown:event];
    else [view keyUp:event];
  }
  return Undefined(env);
}

// debugScreenText(id): string | null — viewport text for headless output checks.
napi_value DebugScreenText(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.model->surface == nullptr) return result;
  // Whole viewport, read without touching the user's selection.
  ghostty_selection_s viewport = {};
  viewport.top_left = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_TOP_LEFT, 0, 0};
  viewport.bottom_right = {GHOSTTY_POINT_VIEWPORT, GHOSTTY_POINT_COORD_BOTTOM_RIGHT, 0, 0};
  viewport.rectangle = false;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(view.model->surface, viewport, &text)) return result;
  result = String(env, std::string(text.text, text.text_len));
  ghostty_surface_free_text(view.model->surface, &text);
  return result;
}

// Class of the view a click at `point` (surface coordinates) would reach, as the window routes it.
std::string HitClassAt(OrcaGhosttySurfaceView* view, NSPoint point) {
  NSView* content = view.window.contentView;
  if (content == nil) return "none";
  const NSPoint inWindow = [view convertPoint:point toView:nil];
  NSView* hit = [content hitTest:content.superview ? [content.superview convertPoint:inWindow fromView:nil] : inWindow];
  return hit ? object_getClassName(hit) : "none";
}

// { total, offset, len, visible, knobProportion, knobPosition, hitScroller, hitBeside } | null
napi_value ScrollbarDebugState(napi_env env, OrcaGhosttySurfaceView* view) {
  napi_value result;
  napi_get_null(env, &result);
  OrcaGhosttyScrollbarView* scrollbar = [OrcaGhosttyScrollbarView scrollbarOf:view create:NO];
  NSScroller* scroller = scrollbar.verticalScroller;
  if (scrollbar == nil || scroller == nil) return result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "total", Number(env, scrollbar.total));
  napi_set_named_property(env, result, "offset", Number(env, scrollbar.offset));
  napi_set_named_property(env, result, "len", Number(env, scrollbar.len));
  napi_set_named_property(env, result, "visible", Bool(env, !scrollbar.hiddenOrHasHiddenAncestor));
  napi_set_named_property(env, result, "knobProportion", Number(env, scroller.knobProportion));
  napi_set_named_property(env, result, "knobPosition", Number(env, scroller.doubleValue));
  const NSRect strip = scrollbar.frame;
  napi_set_named_property(env, result, "hitScroller",
                          String(env, HitClassAt(view, NSMakePoint(NSMidX(strip), NSMidY(strip)))));
  napi_set_named_property(env, result, "hitBeside",
                          String(env, HitClassAt(view, NSMakePoint(NSMinX(strip) - 4, NSMidY(strip)))));
  return result;
}

// [{ x, y, width, height, hit }] in host points; `hit` is the view class a click at its centre reaches.
napi_value OverlayHolesDebugState(napi_env env, OrcaGhosttySurfaceView* view) {
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  for (NSValue* hole in view.overlayHoles) {
    const NSRect local = hole.rectValue;
    const NSRect inHost = [view convertRect:local toView:view.superview];
    napi_value entry;
    napi_create_object(env, &entry);
    napi_set_named_property(env, entry, "x", Number(env, inHost.origin.x));
    napi_set_named_property(env, entry, "y", Number(env, inHost.origin.y));
    napi_set_named_property(env, entry, "width", Number(env, inHost.size.width));
    napi_set_named_property(env, entry, "height", Number(env, inHost.size.height));
    napi_set_named_property(env, entry, "hit",
                            String(env, HitClassAt(view, NSMakePoint(NSMidX(local), NSMidY(local)))));
    napi_set_element(env, result, index++, entry);
  }
  return result;
}

// debugState(id): { hidden, firstResponder, x, y, width, height, scrollbar, holes, masked } | null
napi_value DebugState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil) return result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "hidden", Bool(env, view.hidden));
  napi_set_named_property(env, result, "firstResponder", Bool(env, view.window.firstResponder == view));
  napi_set_named_property(env, result, "x", Number(env, view.frame.origin.x));
  napi_set_named_property(env, result, "y", Number(env, view.frame.origin.y));
  napi_set_named_property(env, result, "width", Number(env, view.frame.size.width));
  napi_set_named_property(env, result, "height", Number(env, view.frame.size.height));
  id contents = view.layer.contents;
  if (contents != nil && CFGetTypeID((__bridge CFTypeRef)contents) == IOSurfaceGetTypeID()) {
    IOSurfaceRef surface = (__bridge IOSurfaceRef)contents;
    napi_set_named_property(env, result, "surfaceWidth", Number(env, IOSurfaceGetWidth(surface)));
    napi_set_named_property(env, result, "surfaceHeight", Number(env, IOSurfaceGetHeight(surface)));
  }
  napi_set_named_property(env, result, "layerClass",
                          String(env, view.layer ? object_getClassName(view.layer) : "none"));
  napi_set_named_property(env, result, "sublayers", Number(env, view.layer.sublayers.count));
  napi_set_named_property(env, result, "scrollbar", ScrollbarDebugState(env, view));
  id responder = view.window.firstResponder;
  napi_set_named_property(env, result, "windowFirstResponder",
                          String(env, responder ? object_getClassName(responder) : "none"));
  napi_set_named_property(env, result, "holes", OverlayHolesDebugState(env, view));
  napi_set_named_property(env, result, "masked", Bool(env, view.layer.mask != nil));
  napi_set_named_property(env, result, "ghosttyFocused", Bool(env, view.ghosttyFocused));
  napi_set_named_property(env, result, "ghosttyVisible", Bool(env, view.ghosttyVisible));
  napi_set_named_property(env, result, "presentedFrames", Number(env, view.presentedFrames));
  napi_set_named_property(env, result, "strayCursorTimers", Number(env, view.strayCursorTimers));
  return result;
}

// debugSnapshot(id): Buffer | null — PNG of the frame Ghostty last presented (its IOSurface).
napi_value DebugSnapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  id contents = view.layer.contents;
  if (contents == nil || CFGetTypeID((__bridge CFTypeRef)contents) != IOSurfaceGetTypeID()) return result;
  CIImage* image = [CIImage imageWithIOSurface:(__bridge IOSurfaceRef)contents];
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCIImage:image];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (png == nil) return result;
  void* out = nullptr;
  napi_create_buffer_copy(env, png.length, png.bytes, &out, &result);
  return result;
}

// debugScrollbarScroll(id, fraction): boolean — moves the scroller as a knob drag would.
napi_value DebugScrollbarScroll(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) return Bool(env, false);
  OrcaGhosttyScrollbarView* scrollbar = [OrcaGhosttyScrollbarView scrollbarOf:ViewForId(GetInt(env, argv[0]))
                                                                       create:NO];
  return Bool(env, scrollbar != nil && [scrollbar debugScrollToFraction:GetDouble(env, argv[1])]);
}

#pragma mark Host chords, keyboard hand-off and drag debugging

// setForwardedChords(chords: Array<[keyCode, modifierFlags, character]>): void — replaces the
// non-Command chords every surface hands to Orca instead of Ghostty.
napi_value SetForwardedChords(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t count = 0;
  if (argc < 1 || napi_get_array_length(env, argv[0], &count) != napi_ok) return Undefined(env);
  auto* chords = count > 0 ? new ForwardedChord[count] : nullptr;
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    napi_get_element(env, argv[0], i, &entry);
    napi_value fields[3];
    for (uint32_t f = 0; f < 3; f++) napi_get_element(env, entry, f, &fields[f]);
    NSString* character = [NSString stringWithUTF8String:GetString(env, fields[2]).c_str()];
    chords[i] = {static_cast<uint16_t>(GetInt(env, fields[0])), static_cast<uint32_t>(GetInt(env, fields[1])),
                 character.length == 1 ? [character.lowercaseString characterAtIndex:0] : static_cast<unichar>(0)};
  }
  delete[] g_forwarded_chords;
  g_forwarded_chords = chords;
  g_forwarded_chord_count = count;
  g_double_tap_watch = false;
  for (uint32_t i = 0; i < count; i++) g_double_tap_watch = g_double_tap_watch || IsModifierKeyCode(chords[i].keyCode);
  return Undefined(env);
}

// The view AppKit's drag session targets at a window point: the deepest visible view registered
// for a dragged type. Private AppKit hit test, used only by debugDrop.
NSView* DragDestinationAt(NSWindow* window, NSPoint windowPoint, NSArray<NSPasteboardType>* types) {
  NSView* content = window.contentView;
  SEL hitTest = NSSelectorFromString(@"_hitTest:dragTypes:");
  if (content == nil || ![content respondsToSelector:hitTest]) return nil;
  CGPoint point = content.superview ? [content.superview convertPoint:windowPoint fromView:nil] : windowPoint;
  using DragHitTest = id (*)(id, SEL, CGPoint*, id);
  id hit = reinterpret_cast<DragHitTest>(objc_msgSend)(content, hitTest, &point, [NSSet setWithArray:types]);
  return [hit isKindOfClass:[NSView class]] ? hit : nil;
}

// debugDrop(id, paths): { destination, operation } | null — drops files at the surface's center
// through whichever destination AppKit would pick, paced like a real drag session (the web
// contents only accepts a drop once its page answered a dragover), for headless tests.
// The last debugDrop's outcome, once it has dropped or given up.
NSDictionary* g_debug_drop_outcome = nil;

// AppKit keeps sending draggingUpdated while a drag hovers, and the web contents answers each
// one asynchronously, so a fixed delay drops before a busy renderer has accepted the drag (it
// then sees a dragleave). Drop once an update reports an accepted operation, as a real drop
// lands only after that hover; give up after ~5 s like a drag that left the window.
void StepDebugDrop(NSView* destination, OrcaDebugDraggingInfo* drag, int updates) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    const int seen = updates + 1;
    const NSDragOperation operation = [destination respondsToSelector:@selector(draggingUpdated:)]
                                          ? [destination draggingUpdated:drag]
                                          : NSDragOperationCopy;
    if ((operation == NSDragOperationNone || seen < 2) && seen < 50) {
      StepDebugDrop(destination, drag, seen);
      return;
    }
    bool performed = false;
    if (operation == NSDragOperationNone) {
      if ([destination respondsToSelector:@selector(draggingExited:)]) [destination draggingExited:drag];
    } else if ((![destination respondsToSelector:@selector(prepareForDragOperation:)] ||
                [destination prepareForDragOperation:drag]) &&
               [destination respondsToSelector:@selector(performDragOperation:)] &&
               [destination performDragOperation:drag]) {
      performed = true;
      if ([destination respondsToSelector:@selector(concludeDragOperation:)]) [destination concludeDragOperation:drag];
    }
    if ([destination respondsToSelector:@selector(draggingEnded:)]) [destination draggingEnded:drag];
    g_debug_drop_outcome = @{@"performed" : @(performed), @"updates" : @(seen), @"operation" : @(operation)};
  });
}

napi_value DebugDrop(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  uint32_t count = 0;
  if (view == nil || view.window == nil || argc < 2 || napi_get_array_length(env, argv[1], &count) != napi_ok) {
    return result;
  }
  NSMutableArray<NSURL*>* urls = [NSMutableArray arrayWithCapacity:count];
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    napi_get_element(env, argv[1], i, &entry);
    [urls addObject:[NSURL fileURLWithPath:[NSString stringWithUTF8String:GetString(env, entry).c_str()]]];
  }
  NSPasteboard* pasteboard = [NSPasteboard pasteboardWithUniqueName];
  [pasteboard clearContents];
  [pasteboard writeObjects:urls];

  OrcaDebugDraggingInfo* drag = [[OrcaDebugDraggingInfo alloc] init];
  drag.pasteboard = pasteboard;
  drag.window = view.window;
  drag.location = [view convertPoint:NSMakePoint(NSMidX(view.bounds), NSMidY(view.bounds)) toView:nil];
  NSView* destination = DragDestinationAt(view.window, drag.location, pasteboard.types);
  if (destination == nil) return result;

  NSDragOperation operation = NSDragOperationNone;
  if ([destination respondsToSelector:@selector(draggingEntered:)]) operation = [destination draggingEntered:drag];
  g_debug_drop_outcome = nil;
  StepDebugDrop(destination, drag, 0);

  napi_create_object(env, &result);
  napi_set_named_property(env, result, "destination", String(env, object_getClassName(destination)));
  napi_set_named_property(env, result, "operation", Number(env, operation));
  return result;
}

// debugDropOutcome(): { performed, updates, operation } | null — null while a drop is in flight.
napi_value DebugDropOutcome(napi_env env, napi_callback_info) {
  napi_value result;
  napi_get_null(env, &result);
  if (g_debug_drop_outcome == nil) return result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "performed", Bool(env, [g_debug_drop_outcome[@"performed"] boolValue]));
  napi_set_named_property(env, result, "updates", Number(env, [g_debug_drop_outcome[@"updates"] intValue]));
  napi_set_named_property(env, result, "operation",
                          Number(env, [g_debug_drop_outcome[@"operation"] unsignedIntegerValue]));
  return result;
}

// releaseKeyboard(ids): void — whichever of these surfaces holds the keyboard gives it to the page.
napi_value ReleaseKeyboard(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t count = 0;
  if (argc < 1 || napi_get_array_length(env, argv[0], &count) != napi_ok) return Undefined(env);
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    napi_get_element(env, argv[0], i, &entry);
    OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, entry));
    if (view != nil && view.window.firstResponder == view) ReturnKeyboardToWebContents(view);
  }
  return Undefined(env);
}

// debugModifiersChanged(id, keyCode, modifierFlags): void — posts a flagsChanged event through the
// app's event queue, so monitors and the first responder see it like a real modifier change.
napi_value DebugModifiersChanged(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || view.window == nil) return Undefined(env);
  NSEvent* event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                    location:NSZeroPoint
                               modifierFlags:static_cast<NSEventModifierFlags>(GetInt(env, argv[2]))
                                   timestamp:NSProcessInfo.processInfo.systemUptime
                                windowNumber:view.window.windowNumber
                                     context:nil
                                  characters:@""
                 charactersIgnoringModifiers:@""
                                   isARepeat:NO
                                     keyCode:static_cast<unsigned short>(GetInt(env, argv[1]))];
  if (event) [NSApp postEvent:event atStart:NO];
  return Undefined(env);
}

#pragma mark Text input, secure input and accessibility exports

bool IsString(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_string;
}

NSString* GetNSString(napi_env env, napi_value value) {
  return [NSString stringWithUTF8String:GetString(env, value).c_str()] ?: @"";
}

napi_value Rect(napi_env env, NSRect rect) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "x", Number(env, rect.origin.x));
  napi_set_named_property(env, result, "y", Number(env, rect.origin.y));
  napi_set_named_property(env, result, "width", Number(env, rect.size.width));
  napi_set_named_property(env, result, "height", Number(env, rect.size.height));
  return result;
}

// setSurfaceAccessibilityLabel(id, label): void — what VoiceOver calls the surface.
napi_value SetSurfaceAccessibilityLabel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view != nil && argc >= 2 && IsString(env, argv[1])) {
    [view setAccessibilityLabel:GetNSString(env, argv[1])];
  }
  return Undefined(env);
}

// setSurfaceShellPid(id, pid): string | null — the local shell whose tty's termios reveals a
// password prompt (0 forgets it); returns that tty's path.
napi_value SetSurfaceShellPid(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  napi_get_null(env, &result);
  const int32_t id = GetInt(env, argv[0]);
  if (ViewForId(id) == nil || g_tty_paths == nil || argc < 2) return result;
  NSString* tty = TtyOfProcess(static_cast<pid_t>(GetInt(env, argv[1])));
  if (tty) {
    g_tty_paths[@(id)] = tty;
    result = String(env, tty.UTF8String);
  } else {
    [g_tty_paths removeObjectForKey:@(id)];
  }
  UpdateSecureInput();
  return result;
}

// Runs `block` while an app event is dispatched: AppKit text input (and Ghostty's insertText)
// expects a current event, as dictation and the character palette have.
void RunDuringAppEvent(void (^block)(void)) {
  const NSInteger marker = 0x4f524341;
  __block id monitor = nil;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskApplicationDefined
                                                  handler:^NSEvent*(NSEvent* event) {
                                                    if (event.data1 != marker || monitor == nil) return event;
                                                    id finished = monitor;
                                                    monitor = nil;
                                                    block();
                                                    dispatch_async(dispatch_get_main_queue(), ^{
                                                      [NSEvent removeMonitor:finished];
                                                    });
                                                    return nil;
                                                  }];
  [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                      location:NSZeroPoint
                                 modifierFlags:0
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:0
                                       context:nil
                                       subtype:0
                                         data1:marker
                                         data2:0]
           atStart:NO];
}

// debugInsertText(id, text): void — what dictation and Emoji & Symbols deliver (insertText:).
napi_value DebugInsertText(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || argc < 2) return Undefined(env);
  NSString* text = GetNSString(env, argv[1]);
  RunDuringAppEvent(^{
    [view insertText:text replacementRange:NSMakeRange(NSNotFound, 0)];
  });
  return Undefined(env);
}

// debugMarkedText(id, text | null, caret): { hasMarkedText } — an IME preedit update or its end.
napi_value DebugMarkedText(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil) return result;
  if (argc >= 2 && IsString(env, argv[1])) {
    const NSUInteger caret = argc >= 3 ? static_cast<NSUInteger>(MAX(0, GetInt(env, argv[2]))) : 0;
    [view setMarkedText:GetNSString(env, argv[1])
          selectedRange:NSMakeRange(caret, 0)
       replacementRange:NSMakeRange(NSNotFound, 0)];
  } else {
    [view unmarkText];
  }
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "hasMarkedText", Bool(env, [view hasMarkedText]));
  return result;
}

// debugImeRect(id, location): { caret, view } — where the IME puts its candidate window (screen).
napi_value DebugImeRect(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || view.window == nil) return result;
  const NSUInteger location = argc >= 2 ? static_cast<NSUInteger>(MAX(0, GetInt(env, argv[1]))) : 0;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "caret",
                          Rect(env, [view firstRectForCharacterRange:NSMakeRange(location, 0) actualRange:nullptr]));
  napi_set_named_property(env, result, "view",
                          Rect(env, [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]]));
  return result;
}

// debugFlags(id, keyCode, modifierFlags): void — a flagsChanged event straight to the view.
napi_value DebugFlags(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || argc < 3) return Undefined(env);
  NSEvent* event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged
                                    location:NSZeroPoint
                               modifierFlags:static_cast<NSEventModifierFlags>(GetInt(env, argv[2]))
                                   timestamp:NSProcessInfo.processInfo.systemUptime
                                windowNumber:view.window.windowNumber
                                     context:nil
                                  characters:@""
                 charactersIgnoringModifiers:@""
                                   isARepeat:NO
                                     keyCode:static_cast<unsigned short>(GetInt(env, argv[1]))];
  if (event) [view flagsChanged:event];
  return Undefined(env);
}

// debugServices(id, op, text?): 'validate' → { sends, takes }, 'write' → string | null,
// 'read' → boolean: the Services menu's three calls into a requestor.
napi_value DebugServices(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil || argc < 2) return result;
  const std::string op = GetString(env, argv[1]);
  if (op == "validate") {
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "sends",
                            Bool(env, [view validRequestorForSendType:NSPasteboardTypeString returnType:nil] == view));
    napi_set_named_property(env, result, "takes",
                            Bool(env, [view validRequestorForSendType:nil returnType:NSPasteboardTypeString] == view));
    return result;
  }
  NSPasteboard* pasteboard = [NSPasteboard pasteboardWithUniqueName];
  if (op == "write") {
    if ([view writeSelectionToPasteboard:pasteboard types:@[ NSPasteboardTypeString ]]) {
      result = String(env, ([pasteboard stringForType:NSPasteboardTypeString] ?: @"").UTF8String);
    }
  } else if (op == "read" && argc >= 3) {
    [pasteboard declareTypes:@[ NSPasteboardTypeString ] owner:nil];
    [pasteboard setString:GetNSString(env, argv[2]) forType:NSPasteboardTypeString];
    result = Bool(env, [view readSelectionFromPasteboard:pasteboard]);
  }
  [pasteboard releaseGlobally];
  return result;
}

// debugAccessibility(id): what VoiceOver reads from the surface.
napi_value DebugAccessibility(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  napi_value result;
  napi_get_null(env, &result);
  if (view == nil) return result;
  NSString* value = [view accessibilityValue];
  const NSRange selected = [view accessibilitySelectedTextRange];
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "isElement", Bool(env, [view isAccessibilityElement]));
  napi_set_named_property(env, result, "role", String(env, [view accessibilityRole].UTF8String));
  napi_set_named_property(env, result, "label", String(env, [view accessibilityLabel].UTF8String));
  napi_set_named_property(env, result, "value", String(env, value.UTF8String ?: ""));
  napi_set_named_property(env, result, "numberOfCharacters", Number(env, [view accessibilityNumberOfCharacters]));
  napi_set_named_property(env, result, "selectedLocation", Number(env, selected.location));
  napi_set_named_property(env, result, "selectedLength", Number(env, selected.length));
  napi_set_named_property(env, result, "lastLine",
                          Number(env, [view accessibilityLineForIndex:static_cast<NSInteger>(value.length)]));
  napi_set_named_property(
      env, result, "selectedTextSettable",
      Bool(env, [view isAccessibilitySelectorAllowed:@selector(setAccessibilitySelectedText:)]));
  return result;
}

// debugAccessibilitySet(id, 'selectedText' | 'value', text): void — an assistive app writing text.
napi_value DebugAccessibilitySet(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  OrcaGhosttySurfaceView* view = ViewForId(GetInt(env, argv[0]));
  if (view == nil || argc < 3) return Undefined(env);
  NSString* text = GetNSString(env, argv[2]);
  if (GetString(env, argv[1]) == "value") {
    [view setAccessibilityValue:[ReadViewportText(view.model->surface) stringByAppendingString:text]];
  } else {
    [view setAccessibilitySelectedText:text];
  }
  return Undefined(env);
}

// debugSecureInput(id, simulate?): secure-input state; `simulate` swaps the system call for a flag.
napi_value DebugSecureInput(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int32_t id = GetInt(env, argv[0]);
  OrcaGhosttySurfaceView* view = ViewForId(id);
  napi_valuetype type = napi_undefined;
  if (argc >= 2 && napi_typeof(env, argv[1], &type) == napi_ok && type == napi_boolean) {
    const bool simulate = GetBool(env, argv[1]);
    if (simulate != g_secure_input_simulated) {
      SetSecureInput(false);
      g_secure_input_simulated = simulate;
    }
    UpdateSecureInput();
  }
  NSString* tty = g_tty_paths[@(id)];
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "simulated", Bool(env, g_secure_input_simulated));
  napi_set_named_property(env, result, "enabled", Bool(env, g_secure_input_on));
  napi_set_named_property(env, result, "owner", Bool(env, g_secure_input_owner == id));
  napi_set_named_property(env, result, "tty", String(env, tty ? tty.UTF8String : ""));
  napi_set_named_property(env, result, "passwordInput", Bool(env, tty != nil && TtyReadsPassword(tty)));
  napi_set_named_property(env, result, "badge", Bool(env, view != nil && SecureInputBadgeOf(view) != nil));
  napi_set_named_property(env, result, "systemEnabled", Bool(env, IsSecureEventInputEnabled()));
  return result;
}

void CollectTextInputMenuItems(NSMenu* menu, NSMutableArray<NSMenuItem*>* found) {
  for (NSMenuItem* item in menu.itemArray) {
    if (item.action == @selector(orderFrontCharacterPalette:) || item.action == @selector(startDictation:)) {
      [found addObject:item];
    }
    if (item.submenu) CollectTextInputMenuItems(item.submenu, found);
  }
}

// debugTextInputMenu(): the Emoji & Symbols and Start Dictation items AppKit put in the menu bar.
napi_value DebugTextInputMenu(napi_env env, napi_callback_info info) {
  NSMutableArray<NSMenuItem*>* found = [NSMutableArray array];
  CollectTextInputMenuItems(NSApp.mainMenu, found);
  napi_value result;
  napi_create_array_with_length(env, found.count, &result);
  for (NSUInteger i = 0; i < found.count; i++) {
    NSMenuItem* item = found[i];
    napi_value entry;
    napi_create_object(env, &entry);
    napi_set_named_property(env, entry, "action", String(env, NSStringFromSelector(item.action).UTF8String));
    napi_set_named_property(env, entry, "keyEquivalent", String(env, item.keyEquivalent.UTF8String ?: ""));
    napi_set_named_property(env, entry, "modifiers", Number(env, item.keyEquivalentModifierMask));
    napi_set_element(env, result, static_cast<uint32_t>(i), entry);
  }
  return result;
}

// debugProcessUsage(pid): CPU time, wakeups, instructions and footprint of a process | null.
napi_value DebugProcessUsage(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  napi_get_null(env, &result);
  rusage_info_v4 usage = {};
  if (argc < 1 ||
      proc_pid_rusage(GetInt(env, argv[0]), RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t*>(&usage)) != 0) {
    return result;
  }
  mach_timebase_info_data_t timebase = {};
  mach_timebase_info(&timebase);
  const auto toNs = [&](uint64_t ticks) { return static_cast<double>(ticks) * timebase.numer / timebase.denom; };
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "userNs", Number(env, toNs(usage.ri_user_time)));
  napi_set_named_property(env, result, "systemNs", Number(env, toNs(usage.ri_system_time)));
  napi_set_named_property(env, result, "interruptWakeups", Number(env, usage.ri_interrupt_wkups));
  napi_set_named_property(env, result, "idleWakeups", Number(env, usage.ri_pkg_idle_wkups));
  napi_set_named_property(env, result, "instructions", Number(env, usage.ri_instructions));
  napi_set_named_property(env, result, "cycles", Number(env, usage.ri_cycles));
  napi_set_named_property(env, result, "footprint", Number(env, usage.ri_phys_footprint));
  return result;
}

// debugCounters(): { ticks, setFrames, presentedFrames, surfaces } since load.
napi_value DebugCounters(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "ticks", Number(env, g_tick_count.load()));
  napi_set_named_property(env, result, "setFrames", Number(env, g_set_frames_count));
  napi_set_named_property(env, result, "presentedFrames", Number(env, g_presented_frames));
  napi_set_named_property(env, result, "surfaces", Number(env, g_views.count));
  return result;
}

// debugWindowOcclusion(onScreen: boolean | null): forces every window on or off screen; null follows AppKit.
napi_value DebugWindowOcclusion(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc > 0) napi_typeof(env, argv[0], &type);
  g_window_occlusion_override = type == napi_boolean ? (GetBool(env, argv[0]) ? 1 : 0) : -1;
  for (OrcaGhosttySurfaceView* view in g_views.allValues) [view syncGhosttyVisible];
  return Undefined(env);
}

napi_value ModuleInit(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
      {"init", nullptr, Init, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"updateConfig", nullptr, UpdateConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"updateSurfaceConfig", nullptr, UpdateSurfaceConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createSurface", nullptr, CreateSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeOutput", nullptr, WriteOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setFrames", nullptr, SetFrames, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"focus", nullptr, Focus, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setAppFocus", nullptr, SetAppFocus, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSelection", nullptr, ReadSelection, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"performAction", nullptr, PerformAction, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"gridSize", nullptr, GridSize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"processExit", nullptr, ProcessExit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroySurface", nullptr, DestroySurface, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugKey", nullptr, DebugKey, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugSnapshot", nullptr, DebugSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugScreenText", nullptr, DebugScreenText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugState", nullptr, DebugState, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugScrollbarScroll", nullptr, DebugScrollbarScroll, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"gridSizeOf", nullptr, GridSize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setForwardedChords", nullptr, SetForwardedChords, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseKeyboard", nullptr, ReleaseKeyboard, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugDrop", nullptr, DebugDrop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugDropOutcome", nullptr, DebugDropOutcome, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugModifiersChanged", nullptr, DebugModifiersChanged, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setSurfaceShellPid", nullptr, SetSurfaceShellPid, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setSurfaceAccessibilityLabel", nullptr, SetSurfaceAccessibilityLabel, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"debugInsertText", nullptr, DebugInsertText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugMarkedText", nullptr, DebugMarkedText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugImeRect", nullptr, DebugImeRect, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugFlags", nullptr, DebugFlags, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugServices", nullptr, DebugServices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugAccessibility", nullptr, DebugAccessibility, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugAccessibilitySet", nullptr, DebugAccessibilitySet, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugSecureInput", nullptr, DebugSecureInput, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugTextInputMenu", nullptr, DebugTextInputMenu, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugProcessUsage", nullptr, DebugProcessUsage, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugCounters", nullptr, DebugCounters, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"debugWindowOcclusion", nullptr, DebugWindowOcclusion, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
