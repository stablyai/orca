import XCTest
@testable import OrcaComputerUseMacOSCore

final class SyntheticMouseClickDeliveryTests: XCTestCase {
    func testSingleClickPlanPairsDownAndUpAfterMove() {
        XCTAssertEqual(
            SyntheticMouseClickDelivery.steps(clickCount: 1),
            [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
        )
    }

    func testMultiClickPlanNumbersEachPressForClickState() {
        XCTAssertEqual(
            SyntheticMouseClickDelivery.steps(clickCount: 2),
            [
                .move,
                .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1),
                .buttonDown(pressIndex: 2), .buttonUp(pressIndex: 2),
            ]
        )
    }

    func testNonPositiveClickCountStillDeliversOnePress() {
        for count in [0, -3] {
            XCTAssertEqual(
                SyntheticMouseClickDelivery.steps(clickCount: count),
                [.move, .buttonDown(pressIndex: 1), .buttonUp(pressIndex: 1)]
            )
        }
    }

    func testClickStateMatchesPressIndexAndSkipsMove() {
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .move), 0)
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .buttonDown(pressIndex: 1)), 1)
        XCTAssertEqual(SyntheticMouseClickDelivery.clickState(for: .buttonUp(pressIndex: 2)), 2)
    }

    func testInterEventPauseIsNonZero() {
        // Unpaced posts race the window server and the mouseUp is dropped,
        // turning the click into a hover-only no-op (STA-3433).
        XCTAssertGreaterThan(SyntheticMouseClickDelivery.interEventPauseMicroseconds, 0)
    }
}
