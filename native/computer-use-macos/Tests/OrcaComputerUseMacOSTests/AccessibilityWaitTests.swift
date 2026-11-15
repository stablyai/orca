import XCTest
@testable import OrcaComputerUseMacOSCore

final class AccessibilityWaitConditionTests: XCTestCase {
    private let tree = """
    App=com.apple.TextEdit (pid 7)
    Window: "Editor"

    0 standard window Editor
    \t1 text All changes saved
    \t2 button (disabled) Continue
    \t3 button Continue later
    \t\t4
    12 lines of notes

    Focused: 1 text
    """

    private func holds(_ kind: String, _ value: String, disabled: Set<Int> = []) -> Bool {
        AccessibilityWaitCondition(kind: kind, value: value)!.holds(treeText: tree, disabledIndexes: disabled)
    }

    func testTextMatchesAnElementLineWithoutItsIndexIgnoringCase() {
        XCTAssertTrue(holds("text", "SAVED"))
        XCTAssertFalse(holds("text", "1 text"))
        XCTAssertFalse(holds("text", "Editor\""))
    }

    func testHeaderAndFooterLinesDoNotMatch() {
        XCTAssertFalse(holds("text", "TextEdit"))
        XCTAssertFalse(holds("text", "Focused"))
    }

    func testEnabledNeedsEveryMatchEnabled() {
        XCTAssertTrue(holds("enabled", "Continue"))
        XCTAssertFalse(holds("enabled", "Continue", disabled: [2]))
        XCTAssertTrue(holds("enabled", "later", disabled: [2]))
        XCTAssertFalse(holds("enabled", "missing"))
    }

    func testUnknownKindsAreRefused() {
        XCTAssertNil(AccessibilityWaitCondition(kind: "window-title", value: "x"))
    }

    func testElementLinesFollowTheCliParser() {
        let lines = AccessibilityWaitCondition.elementLines(tree)
        XCTAssertEqual(lines.map(\.index), [0, 1, 2, 3, 4, 12])
        XCTAssertEqual(lines[4].text, "")
    }
}

final class AccessibilityWaitPlanTests: XCTestCase {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    private func at(_ seconds: TimeInterval) -> Date {
        start.addingTimeInterval(seconds)
    }

    /// Runs the plan with instant reads and the given notification times; returns when each read happened.
    private func readTimes(appPostsNotifications: Bool, timeout: TimeInterval = 1, events: [TimeInterval] = []) -> [TimeInterval] {
        var plan = AccessibilityWaitPlan(deadline: at(timeout), appPostsNotifications: appPostsNotifications)
        var pending = events.sorted()
        var now = start
        var reads: [TimeInterval] = []
        for _ in 0..<200 {
            switch plan.next(now: now) {
            case .finish:
                return reads
            case .read:
                reads.append((now.timeIntervalSince(start) * 1000).rounded() / 1000)
                plan.didRead(at: now)
            case let .wait(until):
                if let event = pending.first, at(event) <= until {
                    pending.removeFirst()
                    now = max(now, at(event))
                    plan.eventArrived(at: now)
                } else {
                    now = until
                }
            }
        }
        XCTFail("plan did not finish")
        return reads
    }

    func testAnAppThatPostsNoNotificationsKeepsTheCliBeat() {
        XCTAssertEqual(readTimes(appPostsNotifications: false), [0, 0.25, 0.5, 0.75])
    }

    func testAnAppThatPostsNotificationsIsReadOnlyAfterThemWithASlowSafetyRead() {
        XCTAssertEqual(readTimes(appPostsNotifications: true, timeout: 2.5), [0, 1, 2])
        XCTAssertEqual(readTimes(appPostsNotifications: true, timeout: 2.5, events: [0.3]), [0, 0.375, 1.375, 2.375])
    }

    func testANotificationIsReadAfterItsBurstPausesInsteadOfAtTheNextBeat() {
        XCTAssertEqual(readTimes(appPostsNotifications: false, events: [0.05, 0.08]), [0, 0.155, 0.405, 0.655, 0.905])
    }

    func testANonstopStreamIsStillReadWithinTwoHundredMilliseconds() {
        let stream = stride(from: 0.01, to: 1.0, by: 0.05).map { $0 }
        XCTAssertEqual(readTimes(appPostsNotifications: true, events: stream).prefix(3), [0, 0.21, 0.46])
    }

    func testANotificationJustBeforeTheDeadlineStillGetsItsRead() {
        XCTAssertEqual(readTimes(appPostsNotifications: true, events: [0.99]), [0, 1])
    }
}
