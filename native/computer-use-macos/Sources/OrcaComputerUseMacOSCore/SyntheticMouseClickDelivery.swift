import CoreGraphics

/// Foreground (--restore-window) clicks: HID taps behind a focused-recipient fence; background clicks use BackgroundInputTransport.
/// Pace down/up events or WindowServer can drop mouseUp.
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

    public enum FenceFailure: Error, Equatable {
        case recipientChanged(expected: Recipient, actual: Recipient?, deliveredPresses: Int)
    }

    public enum Step: Equatable {
        case move
        case buttonDown(pressIndex: Int)
        case buttonUp(pressIndex: Int)
    }

    /// Pace events so WindowServer can route mouseUp.
    public static let interEventPauseMicroseconds: UInt32 = 50_000

    /// Paired presses use pressIndex as click state to register double/triple clicks.
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

    /// Puts the user's pointer back after a HID gesture, unless they moved it at any point during the gesture.
    public struct PointerRestore {
        /// Apps read the live pointer while handling a gesture (hover, menus, drops), so wait before putting it back.
        public static let settleMicroseconds: UInt32 = 200_000

        public private(set) var saved: CGPoint?
        private var lastPosted: CGPoint?
        private var userMoved = false

        public init() {}

        /// Call before posting each event with the live pointer; the first call saves it, and later ones latch
        /// any move away from the previous posted point as the user's.
        public mutating func willPost(at point: CGPoint, current: CGPoint?) {
            if let lastPosted {
                if current.map({ !Self.near($0, lastPosted) }) ?? true {
                    userMoved = true
                }
            } else {
                saved = current
            }
            lastPosted = point
        }

        /// Whether a restore may still be due, so the settle pause is skipped when it can't be.
        public var mayRestore: Bool {
            guard let saved, let lastPosted else { return false }
            return !userMoved && !Self.near(saved, lastPosted)
        }

        public func shouldRestore(current: CGPoint) -> Bool {
            guard mayRestore, let lastPosted else { return false }
            return Self.near(current, lastPosted)
        }

        private static func near(_ a: CGPoint, _ b: CGPoint) -> Bool {
            abs(a.x - b.x) <= 1 && abs(a.y - b.y) <= 1
        }
    }

    /// For a target that never took focus: a click goes to the topmost window at the point, focused or not. A target that
    /// is gone while another window is hit counts as dismissed, so a final press that closes it is not a failure; an empty
    /// hit test while it is still on screen proves nothing, so it is unavailable.
    public static func topmostObservation(hit: RecipientObservation, target: Recipient, targetOnScreen: Bool) -> RecipientObservation {
        guard hit != .focused(target) else { return hit }
        if !targetOnScreen { return .dismissed }
        return hit == .dismissed ? .unavailable : hit
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

    public static func deliverScroll<Event>(
        move: Event,
        wheel: Event,
        target: Recipient,
        currentObservation: () -> RecipientObservation,
        post: (Event) -> Void,
        pause: (UInt32) -> Void
    ) throws {
        try requireRecipient(target, currentObservation: currentObservation)
        post(move)
        pause(interEventPauseMicroseconds)
        try requireRecipient(target, currentObservation: currentObservation)
        post(wheel)
    }

    public static func deliverDrag<Event>(
        move: Event,
        down: Event,
        dragged: [Event],
        up: Event,
        target: Recipient,
        currentObservation: () -> RecipientObservation,
        post: (Event) -> Void,
        pause: (UInt32) -> Void
    ) throws {
        try requireRecipient(target, currentObservation: currentObservation)
        post(move)
        try requireRecipient(target, currentObservation: currentObservation)
        post(down)
        pause(interEventPauseMicroseconds)
        for event in dragged {
            post(event)
            pause(10_000)
        }
        post(up)
    }

    private static func requireRecipient(_ target: Recipient, currentObservation: () -> RecipientObservation) throws {
        let observation = currentObservation()
        guard observation == .focused(target) else {
            throw FenceFailure.recipientChanged(expected: target, actual: observation.recipient, deliveredPresses: 0)
        }
    }

    public static func deliver<Event>(
        clickCount: Int,
        target: Recipient,
        currentObservation: () -> RecipientObservation,
        makeEvent: (Step) throws -> Event,
        post: (Event) -> Void,
        pause: (UInt32) -> Void
    ) throws {
        post(try makeEvent(.move))
        pause(interEventPauseMicroseconds)
        let pressCount = min(max(clickCount, 1), maxClickCount)
        for pressIndex in 1...pressCount {
            let beforeDown = currentObservation()
            guard beforeDown == .focused(target) else {
                throw FenceFailure.recipientChanged(
                    expected: target,
                    actual: beforeDown.recipient,
                    deliveredPresses: pressIndex - 1
                )
            }
            let down = try makeEvent(.buttonDown(pressIndex: pressIndex))
            let up = try makeEvent(.buttonUp(pressIndex: pressIndex))
            post(down)
            pause(interEventPauseMicroseconds)
            post(up)
            let afterUp = currentObservation()
            // A final mouse-up may dismiss the target, but an unavailable probe is unsafe.
            let finalDismissal = pressIndex == pressCount && afterUp == .dismissed
            guard afterUp == .focused(target) || finalDismissal else {
                throw FenceFailure.recipientChanged(
                    expected: target,
                    actual: afterUp.recipient,
                    deliveredPresses: pressIndex
                )
            }
            pause(interEventPauseMicroseconds)
        }
    }
}
