import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class PointerMotionPolicyTests: XCTestCase {
    func testNormalMotionIsBoundedAndEndsAtDestination() {
        let destination = CGPoint(x: 120, y: 80)
        let plan = PointerMotionPolicy.approachPlan(
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
        let plan = PointerMotionPolicy.approachPlan(
            from: CGPoint(x: 20, y: 30),
            to: destination,
            reduceMotion: true
        )

        XCTAssertEqual(plan.points, [destination])
        XCTAssertEqual(plan.delayMicroseconds, 0)
    }

    func testNormalDragIsBoundedAndEndsAtDestination() {
        let destination = CGPoint(x: 320, y: 180)
        let plan = PointerMotionPolicy.dragPlan(
            from: .zero,
            to: destination,
            reduceMotion: false
        )

        XCTAssertEqual(plan.points.count, PointerMotionPolicy.dragSteps)
        XCTAssertEqual(plan.points.last, destination)
        XCTAssertEqual(plan.delayMicroseconds, PointerMotionPolicy.dragDelayMicroseconds)
    }

    func testReduceMotionDragUsesOnlyDestinationWithoutDelay() {
        let destination = CGPoint(x: 75, y: -25)
        let plan = PointerMotionPolicy.dragPlan(
            from: CGPoint(x: 10, y: 20),
            to: destination,
            reduceMotion: true
        )

        XCTAssertEqual(plan.points, [destination])
        XCTAssertEqual(plan.delayMicroseconds, 0)
    }
}
