import XCTest
@testable import OrcaComputerUseMacOSCore

final class AccessibilitySettlePlanTests: XCTestCase {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    private func at(_ seconds: TimeInterval) -> Date {
        start.addingTimeInterval(seconds)
    }

    /// Runs the plan with instant reads and the given notification times; returns when each read happened.
    private func readTimes(appPostsNotifications: Bool, events: [TimeInterval] = [], eventsBeforeStart: Bool = false) -> [TimeInterval] {
        var plan = AccessibilitySettlePlan(start: start, appPostsNotifications: appPostsNotifications, eventsBeforeStart: eventsBeforeStart)
        var pending = events.sorted()
        var now = start
        var reads: [TimeInterval] = []
        for _ in 0..<100 {
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

    func testAnAppThatPostsNoNotificationsKeepsTheOldTwoHundredMillisecondBeat() {
        XCTAssertEqual(readTimes(appPostsNotifications: false), [0.2, 0.4, 0.6, 0.8, 1.0])
    }

    func testANotificationIsReadAfterTheBurstPausesInsteadOfAtTheNextBeat() {
        XCTAssertEqual(readTimes(appPostsNotifications: false, events: [0.05, 0.08]).first, 0.155)
    }

    func testANonstopNotificationStreamIsStillReadWithinTwoHundredMillisecondsOfItsFirstUnreadEvent() {
        let stream = stride(from: 0.0, to: 1.0, by: 0.05).map { $0 }
        XCTAssertEqual(readTimes(appPostsNotifications: true, events: stream), [0.2, 0.45, 0.7, 0.95])
    }

    func testAnAppKnownToPostNotificationsEndsAfterAQuietWindowWithOneCheckRead() {
        XCTAssertEqual(readTimes(appPostsNotifications: true), [0.4])
    }

    func testNotificationsDuringTheActionAreReadRightAway() {
        XCTAssertEqual(readTimes(appPostsNotifications: true, eventsBeforeStart: true).first, 0.075)
    }

    func testAQuietWindowRestartsAfterEachNotification() {
        XCTAssertEqual(readTimes(appPostsNotifications: true, events: [0.3]), [0.375, 0.7])
    }

    func testTrustNeedsAnAnnouncedChangeAndIsLostForGoodAfterASilentOne() {
        var trust = AccessibilityNotificationTrust()
        XCTAssertFalse(trust.postsNotifications)
        trust.observedChange(announced: true)
        XCTAssertTrue(trust.postsNotifications)
        trust.observedChange(announced: false)
        XCTAssertFalse(trust.postsNotifications)
        trust.observedChange(announced: true)
        XCTAssertFalse(trust.postsNotifications)
    }
}
