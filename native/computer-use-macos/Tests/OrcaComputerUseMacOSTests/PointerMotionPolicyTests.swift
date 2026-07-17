import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class PointerMotionPolicyTests: XCTestCase {
    func testNormalMotionIsBoundedAndEndsAtDestination() {
        let destination = CGPoint(x: 120, y: 80)
        let plan = PointerMotionPolicy.plan(
            from: .zero,
            to: destination,
            reduceMotion: false
        )

        XCTAssertEqual(plan.points.count, PointerMotionPolicy.approachSteps)
        XCTAssertEqual(plan.points.last, destination)
        XCTAssertEqual(
            plan.delayMicroseconds,
            PointerMotionPolicy.approachDelayMicroseconds
        )
    }

    func testReduceMotionJumpsDirectlyWithoutDelay() {
        let destination = CGPoint(x: -40, y: 250)
        let plan = PointerMotionPolicy.plan(
            from: CGPoint(x: 20, y: 30),
            to: destination,
            reduceMotion: true
        )

        XCTAssertEqual(plan.points, [destination])
        XCTAssertEqual(plan.delayMicroseconds, 0)
    }
}
