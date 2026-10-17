import ApplicationServices

/// What `AXUIElementPerformAction`'s result says about whether the app ran the action.
public enum AccessibilityActionOutcome: Equatable, Sendable {
    case performed
    /// The element advertised the action and the app took the call, so it may have run despite the
    /// error: Finder returns `attributeUnsupported` for AXOpen on a sidebar row and still opens the
    /// folder (#26457).
    case unconfirmed(axError: Int32)
    case notPerformed(axError: Int32)

    public static func classify(_ error: AXError) -> AccessibilityActionOutcome {
        switch error {
        case .success:
            return .performed
        case .invalidUIElement, .actionUnsupported, .illegalArgument, .apiDisabled, .notImplemented:
            return .notPerformed(axError: error.rawValue)
        default:
            return .unconfirmed(axError: error.rawValue)
        }
    }
}
