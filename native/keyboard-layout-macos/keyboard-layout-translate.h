#ifndef ORCA_KEYBOARD_LAYOUT_TRANSLATE_H
#define ORCA_KEYBOARD_LAYOUT_TRANSLATE_H

#include <Carbon/Carbon.h>
#include <stdbool.h>

// Eight UTF-16 units keep supplementary-plane layout characters intact.
#define ORCA_KEY_CHARACTER_CAPACITY 8

typedef struct {
  const char *code;
  UInt16 keyCode;
} OrcaDomKeyCode;

static const OrcaDomKeyCode ORCA_DOM_KEY_CODES[] = {
  {"KeyA", 0}, {"KeyS", 1}, {"KeyD", 2}, {"KeyF", 3}, {"KeyH", 4}, {"KeyG", 5},
  {"KeyZ", 6}, {"KeyX", 7}, {"KeyC", 8}, {"KeyV", 9}, {"KeyB", 11}, {"KeyQ", 12},
  {"KeyW", 13}, {"KeyE", 14}, {"KeyR", 15}, {"KeyY", 16}, {"KeyT", 17},
  {"Digit1", 18}, {"Digit2", 19}, {"Digit3", 20}, {"Digit4", 21}, {"Digit6", 22},
  {"Digit5", 23}, {"Equal", 24}, {"Digit9", 25}, {"Digit7", 26}, {"Minus", 27},
  {"Digit8", 28}, {"Digit0", 29}, {"BracketRight", 30}, {"KeyO", 31}, {"KeyU", 32},
  {"BracketLeft", 33}, {"KeyI", 34}, {"KeyP", 35}, {"KeyL", 37}, {"KeyJ", 38},
  {"Quote", 39}, {"KeyK", 40}, {"Semicolon", 41}, {"Backslash", 42}, {"Comma", 43},
  {"Slash", 44}, {"KeyN", 45}, {"KeyM", 46}, {"Period", 47}, {"Space", 49},
  {"Backquote", 50}, {"IntlBackslash", 10}, {"IntlYen", 93}, {"IntlRo", 94}
};

static const size_t ORCA_DOM_KEY_CODE_COUNT = sizeof(ORCA_DOM_KEY_CODES) / sizeof(ORCA_DOM_KEY_CODES[0]);

static const UInt32 ORCA_SHIFT_MODIFIER_STATE = shiftKey >> 8;

/** Character for one key with dead keys disabled; false when the layout produces nothing. */
static bool orcaTranslateKey(
  const UCKeyboardLayout *layout,
  UInt16 keyCode,
  UInt32 modifierState,
  UInt32 keyboardType,
  UniChar characters[ORCA_KEY_CHARACTER_CAPACITY],
  UniCharCount *length
) {
  UInt32 deadKeyState = 0;
  *length = 0;
  OSStatus status = UCKeyTranslate(
    layout,
    keyCode,
    kUCKeyActionDown,
    modifierState,
    keyboardType,
    kUCKeyTranslateNoDeadKeysMask,
    &deadKeyState,
    ORCA_KEY_CHARACTER_CAPACITY,
    length,
    characters
  );
  return status == noErr && *length > 0;
}

#endif
