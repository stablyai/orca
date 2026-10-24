import CoreGraphics

public enum KeyboardInputSafety {
    public enum FocusFailure: Equatable {
        case targetNotFocused
        case targetNotFocusedAfterRestore
    }

    public static func syntheticInputFocusFailure(targetWindowFocused: Bool, restoreWindowRequested: Bool) -> FocusFailure? {
        guard !targetWindowFocused else {
            return nil
        }
        return restoreWindowRequested ? .targetNotFocusedAfterRestore : .targetNotFocused
    }

    /// UTF-16 units a synthetic key event should carry.
    /// Key-down is the insertion path: Chromium forwards key-up without
    /// interpretKeyEvents, and Blink's key-up only dispatches a DOM keyup.
    /// Apple warns that a framework may ignore the Unicode string and
    /// translate from the virtual key code, so the typed character is not
    /// copied onto key-up.
    static func unicodeUnitCount(forKeyDown keyDown: Bool) -> Int {
        keyDown ? 1 : 0
    }

    /// Writes one character onto a key-down/key-up pair. Does not post the events.
    public static func attachCharacter(_ unit: UInt16, keyDown: CGEvent, keyUp: CGEvent) {
        writeUnicode(unit, to: keyDown, keyDown: true)
        writeUnicode(unit, to: keyUp, keyDown: false)
    }

    static func unicodeUnits(of event: CGEvent) -> [UInt16] {
        var length = 0
        event.keyboardGetUnicodeString(maxStringLength: 0, actualStringLength: &length, unicodeString: nil)
        guard length > 0 else {
            return []
        }
        var units = [UInt16](repeating: 0, count: length)
        event.keyboardGetUnicodeString(
            maxStringLength: length,
            actualStringLength: &length,
            unicodeString: &units
        )
        return Array(units.prefix(length))
    }

    private static func writeUnicode(_ unit: UInt16, to event: CGEvent, keyDown: Bool) {
        let count = unicodeUnitCount(forKeyDown: keyDown)
        guard count > 0 else {
            return
        }
        var char = unit
        event.keyboardSetUnicodeString(stringLength: count, unicodeString: &char)
    }
}
