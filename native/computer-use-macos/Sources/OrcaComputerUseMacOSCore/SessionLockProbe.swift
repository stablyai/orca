import CoreGraphics
import Foundation

// Why: display sleep, the screen saver and a manual lock all put the session behind the lock screen, where macOS
// reports Accessibility as untrusted and hides app windows; without this check that reads as a missing permission.
public enum SessionLockProbe {
    public static let screenIsLockedKey = "CGSSessionScreenIsLocked"
    public static let lockedMessage = "The Mac's screen is locked or asleep, so Orca can't see or control windows. Wake and unlock the Mac, then retry."

    /// Read fresh on every call: the lock can start or end at any moment.
    public static func isLocked() -> Bool {
        isLocked(session: CGSessionCopyCurrentDictionary() as? [String: Any])
    }

    /// No session dictionary (no window-server session) or no key is how an unlocked session reports itself.
    public static func isLocked(session: [String: Any]?) -> Bool {
        (session?[screenIsLockedKey] as? NSNumber)?.boolValue ?? false
    }
}
