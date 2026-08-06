/// Event plan for synthetic mouse clicks (STA-3433).
///
/// Clicks must be posted to the HID event tap, not `CGEventPostToPid`:
/// pid-targeted mouse events reach the app with no window association, so
/// AppKit never routes the press to a view (hover fires, activation never
/// happens). The window server also drops a mouseUp posted back-to-back
/// with its mouseDown, so consecutive events need a pause between them.
public enum SyntheticMouseClickDelivery {
    public enum Step: Equatable {
        case move
        case buttonDown(pressIndex: Int)
        case buttonUp(pressIndex: Int)
    }

    /// Pause after posting each event; unpaced posts race the window
    /// server's routing and the mouseUp is silently dropped.
    public static let interEventPauseMicroseconds: UInt32 = 50_000

    /// One move, then a paired down/up per press. `pressIndex` becomes the
    /// event's click state so repeated presses register as double/triple
    /// clicks instead of independent single clicks.
    public static func steps(clickCount: Int) -> [Step] {
        var steps: [Step] = [.move]
        for press in 1...max(clickCount, 1) {
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
}
