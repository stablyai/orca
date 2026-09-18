/// Event plan for synthetic mouse clicks (STA-3433).
///
/// Clicks must be posted to the HID event tap, not `CGEventPostToPid`:
/// pid-targeted mouse events reach the app with no window association, so
/// AppKit never routes the press to a view (hover fires, activation never
/// happens). The window server also drops a mouseUp posted back-to-back
/// with its mouseDown, so consecutive events need a pause between them.
public enum SyntheticMouseClickDelivery {
    public static let maxClickCount = 3

    public struct Recipient: Equatable, Sendable {
        public let ownerPID: Int32
        public let windowID: UInt32

        public init(ownerPID: Int32, windowID: UInt32) {
            self.ownerPID = ownerPID
            self.windowID = windowID
        }
    }

    public enum RecipientObservation: Equatable, Sendable {
        case focused(Recipient)
        case dismissed
        case unavailable

        var recipient: Recipient? {
            guard case let .focused(recipient) = self else { return nil }
            return recipient
        }
    }

    /// Which fence sample observed the recipient change; callers cannot
    /// distinguish before-down from after-up via deliveredPresses alone.
    public enum FencePhase: Equatable, Sendable {
        case beforePress
        case afterPress
    }

    public enum FenceFailure: Error, Equatable {
        case recipientChanged(
            expected: Recipient,
            actual: Recipient?,
            deliveredPresses: Int,
            phase: FencePhase
        )

        public var deliveredPresses: Int {
            switch self {
            case let .recipientChanged(_, _, presses, _): presses
            }
        }

        public var phase: FencePhase {
            switch self {
            case let .recipientChanged(_, _, _, phase): phase
            }
        }
    }

    public enum Step: Equatable {
        case move
        case buttonDown(pressIndex: Int)
        case buttonUp(pressIndex: Int)
    }

    /// Which fence checkpoint is sampling; lets the probe reserve settling
    /// for the nothing-delivered-yet case and stay fail-closed afterwards.
    public enum FenceSample: Equatable, Sendable {
        case beforePress(pressIndex: Int)
        case afterRelease(pressIndex: Int)

        public var allowsRecovery: Bool {
            guard case .beforePress(pressIndex: 1) = self else { return false }
            return true
        }
    }

    /// Pause after posting each event; unpaced posts race the window
    /// server's routing and the mouseUp is silently dropped.
    public static let interEventPauseMicroseconds: UInt32 = 50_000

    /// One move, then a paired down/up per press. `pressIndex` becomes the
    /// event's click state so repeated presses register as double/triple
    /// clicks instead of independent single clicks.
    public static func steps(clickCount: Int) -> [Step] {
        var steps: [Step] = [.move]
        for press in 1...min(max(clickCount, 1), maxClickCount) {
            steps.append(.buttonDown(pressIndex: press))
            steps.append(.buttonUp(pressIndex: press))
        }
        return steps
    }

    /// Click state field value for a step; 0 leaves the field unset.
    public static func clickState(for step: Step) -> Int64 {
        switch step {
        case .move:
            return 0
        case let .buttonDown(pressIndex), let .buttonUp(pressIndex):
            return Int64(pressIndex)
        }
    }

    /// Retries only observations the caller classifies as transient.
    public static func settledObservation(
        attempts: Int,
        interProbePauseMicroseconds: UInt32,
        currentObservation: () -> RecipientObservation,
        shouldRetry: (RecipientObservation) -> Bool,
        pause: (UInt32) -> Void
    ) -> RecipientObservation {
        guard attempts > 0 else { return .unavailable }
        var observation = RecipientObservation.unavailable
        for attempt in 1...attempts {
            observation = currentObservation()
            guard shouldRetry(observation) else { return observation }
            if attempt < attempts {
                pause(interProbePauseMicroseconds)
            }
        }
        return observation
    }

    public static func uniqueWindowCandidate<Candidate>(
        from candidates: [Candidate],
        matching predicate: (Candidate) -> Bool
    ) -> Candidate? {
        var match: Candidate?
        for candidate in candidates where predicate(candidate) {
            guard match == nil else { return nil }
            match = candidate
        }
        return match
    }

    public static func deliver<Event>(
        clickCount: Int,
        target: Recipient,
        currentObservation: (FenceSample) -> RecipientObservation,
        makeEvent: (Step) throws -> Event,
        post: (Event) -> Void,
        pause: (UInt32) -> Void
    ) throws {
        post(try makeEvent(.move))
        pause(interEventPauseMicroseconds)
        let pressCount = min(max(clickCount, 1), maxClickCount)
        for pressIndex in 1...pressCount {
            let beforeDown = currentObservation(.beforePress(pressIndex: pressIndex))
            guard beforeDown == .focused(target) else {
                throw FenceFailure.recipientChanged(
                    expected: target,
                    actual: beforeDown.recipient,
                    deliveredPresses: pressIndex - 1,
                    phase: .beforePress
                )
            }
            let down = try makeEvent(.buttonDown(pressIndex: pressIndex))
            let up = try makeEvent(.buttonUp(pressIndex: pressIndex))
            post(down)
            pause(interEventPauseMicroseconds)
            post(up)
            let afterUp = currentObservation(.afterRelease(pressIndex: pressIndex))
            // A final mouse-up may dismiss the target, but an unavailable probe is unsafe.
            let finalDismissal = pressIndex == pressCount && afterUp == .dismissed
            guard afterUp == .focused(target) || finalDismissal else {
                throw FenceFailure.recipientChanged(
                    expected: target,
                    actual: afterUp.recipient,
                    deliveredPresses: pressIndex,
                    phase: .afterPress
                )
            }
            pause(interEventPauseMicroseconds)
        }
    }
}
