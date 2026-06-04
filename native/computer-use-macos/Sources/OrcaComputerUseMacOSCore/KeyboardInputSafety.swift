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
}
