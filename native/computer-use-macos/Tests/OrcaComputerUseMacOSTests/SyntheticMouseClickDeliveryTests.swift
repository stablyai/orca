import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
    func testPointerGoesBackOnlyWhileItStillSitsWhereTheGestureLeftIt() {
        let saved = CGPoint(x: 100, y: 100)
        let clicked = CGPoint(x: 640.5, y: 480.25)
        XCTAssertTrue(SyntheticMouseClickDelivery.shouldRestorePointer(saved: saved, lastPosted: clicked, current: clicked))
        XCTAssertFalse(SyntheticMouseClickDelivery.shouldRestorePointer(saved: saved, lastPosted: clicked, current: CGPoint(x: 655, y: 470)))
        XCTAssertFalse(SyntheticMouseClickDelivery.shouldRestorePointer(saved: saved, lastPosted: nil, current: saved))
    }
}
