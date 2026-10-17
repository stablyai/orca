public enum AccessibilityTextWrite {
    public enum Outcome: Equatable {
        case notWritten
        case written(actual: String?)
    }

    public static func perform(write: () -> Bool, read: () -> String?) -> Outcome {
        guard write() else { return .notWritten }
        // A stale read does not undo a successful write or make a second input safe.
        return .written(actual: read())
    }
}
