import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class ForegroundDeliveryTests: XCTestCase {
    private func observation(_ frontmost: Bool, _ focusedWindowID: CGWindowID? = nil) -> ForegroundDelivery.Observation {
        ForegroundDelivery.Observation(frontmost: frontmost, focusedWindowID: focusedWindowID)
    }

    func testBackgroundActionThatActivatesTheAppReportsForeground() {
        XCTAssertTrue(ForegroundDelivery.tookForeground(before: observation(false), after: observation(true, 7), targetWindowID: 7, restoreRequested: false))
        XCTAssertFalse(ForegroundDelivery.tookForeground(before: observation(false), after: observation(false), targetWindowID: 7, restoreRequested: false))
    }

    func testActiveAppCountsOnlyWhenTheTargetWindowBecameKey() {
        XCTAssertTrue(ForegroundDelivery.tookForeground(before: observation(true, 3), after: observation(true, 7), targetWindowID: 7, restoreRequested: false))
        XCTAssertFalse(ForegroundDelivery.tookForeground(before: observation(true, 7), after: observation(true, 7), targetWindowID: 7, restoreRequested: false))
        XCTAssertFalse(ForegroundDelivery.tookForeground(before: observation(true, 3), after: observation(true, 3), targetWindowID: 7, restoreRequested: false))
    }

    func testRestoreReportsWhatHappenedNotWhatWasAsked() {
        XCTAssertTrue(ForegroundDelivery.tookForeground(before: observation(true, 7), after: observation(true, 7), targetWindowID: 7, restoreRequested: true))
        XCTAssertFalse(ForegroundDelivery.tookForeground(before: observation(false), after: observation(false), targetWindowID: 7, restoreRequested: true))
    }
}
