import Carbon
import Foundation

struct KeyCharacters: Codable {
  let unmodified: String?
  let shifted: String?
}

struct KeyboardLayoutSnapshot: Codable {
  let inputSourceId: String?
  let layoutSourceId: String?
  let keyCharacters: [String: KeyCharacters]
}

let domKeyCodes: [(String, UInt16)] = [
  ("KeyA", 0), ("KeyS", 1), ("KeyD", 2), ("KeyF", 3), ("KeyH", 4), ("KeyG", 5),
  ("KeyZ", 6), ("KeyX", 7), ("KeyC", 8), ("KeyV", 9), ("KeyB", 11), ("KeyQ", 12),
  ("KeyW", 13), ("KeyE", 14), ("KeyR", 15), ("KeyY", 16), ("KeyT", 17),
  ("Digit1", 18), ("Digit2", 19), ("Digit3", 20), ("Digit4", 21), ("Digit6", 22),
  ("Digit5", 23), ("Equal", 24), ("Digit9", 25), ("Digit7", 26), ("Minus", 27),
  ("Digit8", 28), ("Digit0", 29), ("BracketRight", 30), ("KeyO", 31), ("KeyU", 32),
  ("BracketLeft", 33), ("KeyI", 34), ("KeyP", 35), ("KeyL", 37), ("KeyJ", 38),
  ("Quote", 39), ("KeyK", 40), ("Semicolon", 41), ("Backslash", 42), ("Comma", 43),
  ("Slash", 44), ("KeyN", 45), ("KeyM", 46), ("Period", 47), ("Space", 49),
  ("Backquote", 50), ("IntlBackslash", 10), ("IntlYen", 93), ("IntlRo", 94)
]

func inputSourceId(_ source: TISInputSource?) -> String? {
  guard let source,
        let rawId = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
    return nil
  }
  return Unmanaged<CFString>.fromOpaque(rawId).takeUnretainedValue() as String
}

func translatedCharacter(
  layout: UnsafePointer<UCKeyboardLayout>,
  keyCode: UInt16,
  modifiers: UInt32
) -> String? {
  var deadKeyState: UInt32 = 0
  var length = 0
  var characters = [UniChar](repeating: 0, count: 8)
  let status = UCKeyTranslate(
    layout,
    keyCode,
    UInt16(kUCKeyActionDown),
    modifiers,
    UInt32(LMGetKbdType()),
    OptionBits(kUCKeyTranslateNoDeadKeysMask),
    &deadKeyState,
    characters.count,
    &length,
    &characters
  )
  guard status == noErr, length > 0 else {
    return nil
  }
  return String(utf16CodeUnits: characters, count: length)
}

func readStableSnapshot() -> KeyboardLayoutSnapshot? {
  let currentInputSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
  let currentLayoutSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
  let capturedInputSourceId = inputSourceId(currentInputSource)
  let capturedLayoutSourceId = inputSourceId(currentLayoutSource)
  var keyCharacters: [String: KeyCharacters] = [:]

  if let currentLayoutSource,
     let rawData = TISGetInputSourceProperty(
       currentLayoutSource,
       kTISPropertyUnicodeKeyLayoutData
     ) {
    let data = Unmanaged<CFData>.fromOpaque(rawData).takeUnretainedValue()
    if let bytes = CFDataGetBytePtr(data) {
      let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
      for (code, keyCode) in domKeyCodes {
        keyCharacters[code] = KeyCharacters(
          unmodified: translatedCharacter(layout: layout, keyCode: keyCode, modifiers: 0),
          shifted: translatedCharacter(
            layout: layout,
            keyCode: keyCode,
            modifiers: UInt32(shiftKey >> 8)
          )
        )
      }
    }
  }

  let finalInputSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
  let finalLayoutSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
  guard capturedInputSourceId == inputSourceId(finalInputSource),
        capturedLayoutSourceId == inputSourceId(finalLayoutSource) else {
    return nil
  }
  return KeyboardLayoutSnapshot(
    inputSourceId: capturedInputSourceId,
    layoutSourceId: capturedLayoutSourceId,
    keyCharacters: keyCharacters
  )
}

for _ in 0..<2 {
  if let snapshot = readStableSnapshot() {
    let encoded = try JSONEncoder().encode(snapshot)
    print(String(decoding: encoded, as: UTF8.self))
    exit(0)
  }
}
exit(1)
