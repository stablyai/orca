import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Decides, before synthetic input is sent, whether it would mix with the user's own typing or go to a secure field.
public enum KeyboardContention {
    /// The user's last key press counts as active typing for this long.
    public static let userTypingQuietPeriod: TimeInterval = 2.0
    /// A key press this close after the helper's own input is taken to be that input, not the user's.
    static let ownInputTolerance: TimeInterval = 0.05
    public static let secureInputPIDKey = "kCGSSessionSecureInputPID"

    public enum Refusal: Equatable {
        case secureInputActive(ownerPID: pid_t?)
        case userTyping(secondsAgo: TimeInterval)
    }

    public struct Conditions: Equatable {
        public var secureInputEnabled: Bool
        public var secureInputOwnerPID: pid_t?
        public var secondsSinceUserKeyDown: TimeInterval
        public var secondsSinceOwnInput: TimeInterval?

        public init(
            secureInputEnabled: Bool,
            secureInputOwnerPID: pid_t?,
            secondsSinceUserKeyDown: TimeInterval,
            secondsSinceOwnInput: TimeInterval?
        ) {
            self.secureInputEnabled = secureInputEnabled
            self.secureInputOwnerPID = secureInputOwnerPID
            self.secondsSinceUserKeyDown = secondsSinceUserKeyDown
            self.secondsSinceOwnInput = secondsSinceOwnInput
        }
    }

    /// - Parameters:
    ///   - sharesUserKeyboard: the input goes where the user's keys go: the HID stream (foreground delivery) or the
    ///     app that is active. Background input to an inactive app reaches only that app, so the user's typing is safe.
    ///   - sendsKeys: false for a click, which can move the user's keyboard focus but types nothing.
    public static func refusal(
        targetPID: pid_t,
        sharesUserKeyboard: Bool,
        sendsKeys: Bool,
        conditions: Conditions
    ) -> Refusal? {
        if sendsKeys, conditions.secureInputEnabled,
           sharesUserKeyboard || conditions.secureInputOwnerPID == targetPID {
            return .secureInputActive(ownerPID: conditions.secureInputOwnerPID)
        }
        guard sharesUserKeyboard, conditions.secondsSinceUserKeyDown < userTypingQuietPeriod else {
            return nil
        }
        // Why: foreground keys the helper posted itself can show up as the session's latest key press.
        if let ownInput = conditions.secondsSinceOwnInput,
           conditions.secondsSinceUserKeyDown >= ownInput - ownInputTolerance {
            return nil
        }
        return .userTyping(secondsAgo: conditions.secondsSinceUserKeyDown)
    }

    /// Read fresh before each input: a password field can take focus, and the user can start typing, at any moment.
    public static func currentConditions(ownInput: OwnInputClock = .shared) -> Conditions {
        Conditions(
            secureInputEnabled: IsSecureEventInputEnabled(),
            secureInputOwnerPID: secureInputOwnerPID(session: CGSessionCopyCurrentDictionary() as? [String: Any]),
            secondsSinceUserKeyDown: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown),
            secondsSinceOwnInput: ownInput.secondsSinceLastInput()
        )
    }

    public static func secureInputOwnerPID(session: [String: Any]?) -> pid_t? {
        guard let pid = (session?[secureInputPIDKey] as? NSNumber)?.int32Value, pid > 0 else { return nil }
        return pid
    }

    /// When the helper last posted keys or a click itself.
    public final class OwnInputClock: @unchecked Sendable {
        public static let shared = OwnInputClock()
        private let lock = NSLock()
        private var lastInput: CFAbsoluteTime?
        private let now: () -> CFAbsoluteTime

        public init(now: @escaping () -> CFAbsoluteTime = CFAbsoluteTimeGetCurrent) {
            self.now = now
        }

        public func recordInput() {
            lock.lock()
            defer { lock.unlock() }
            lastInput = now()
        }

        public func secondsSinceLastInput() -> TimeInterval? {
            lock.lock()
            defer { lock.unlock() }
            return lastInput.map { now() - $0 }
        }
    }
}
