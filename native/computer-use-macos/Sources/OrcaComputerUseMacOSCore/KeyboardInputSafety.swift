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

    /// How many UTF-16 units a synthetic key event should carry.
    /// Key-up stays empty: Electron contentEditable inserts the payload of both events.
    public static func unicodeUnitCount(forKeyDown keyDown: Bool) -> Int {
        keyDown ? 1 : 0
    }
}
