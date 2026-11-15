import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
    private let saved = CGPoint(x: 100, y: 100)
    private let clicked = CGPoint(x: 640.5, y: 480.25)

    func testPointerGoesBackWhenItStillSitsWhereTheGestureLeftIt() {
        var restore = SyntheticMouseClickDelivery.PointerRestore(saved: saved)
        restore.willPost(at: clicked, current: saved)
        restore.willPost(at: clicked, current: clicked)
        XCTAssertTrue(restore.shouldRestore(current: clicked))
        XCTAssertFalse(restore.shouldRestore(current: CGPoint(x: 655, y: 470)))
    }

    func testUserMovementBetweenEventsKeepsThePointerWhereTheUserPutIt() {
        var restore = SyntheticMouseClickDelivery.PointerRestore(saved: saved)
        restore.willPost(at: clicked, current: saved)
        restore.willPost(at: clicked, current: CGPoint(x: 655, y: 470))
        XCTAssertFalse(restore.mayRestore)
        XCTAssertFalse(restore.shouldRestore(current: clicked))
    }
}
