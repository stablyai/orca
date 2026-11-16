import CoreGraphics

/// Decides from what happened, not from the request, whether an action put the target in front of the user.
public enum ForegroundDelivery {
    public struct Observation: Equatable {
        public let frontmost: Bool
        /// Read only while the app is frontmost, since only then is its key window the user's.
        public let focusedWindowID: CGWindowID?

        public init(frontmost: Bool, focusedWindowID: CGWindowID?) {
            self.frontmost = frontmost
            self.focusedWindowID = focusedWindowID
        }
    }

    public static func tookForeground(
        before: Observation,
        after: Observation,
        targetWindowID: CGWindowID,
        restoreRequested: Bool
    ) -> Bool {
        guard after.frontmost else { return false }
        // Why: --restore-window input goes through the HID tap, which lands in whatever is in front.
        if restoreRequested || !before.frontmost { return true }
        return before.focusedWindowID != targetWindowID && after.focusedWindowID == targetWindowID
    }
}
