import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class PointerMotionPathTests: XCTestCase {
    func testInterpolatesEvenlyAndEndsAtDestination() {
        let points = PointerMotionPath.points(
            from: CGPoint(x: 10, y: 20),
            to: CGPoint(x: 22, y: 8),
            steps: 3
        )

        XCTAssertEqual(points, [
            CGPoint(x: 14, y: 16),
            CGPoint(x: 18, y: 12),
            CGPoint(x: 22, y: 8),
        ])
    }

    func testNonPositiveStepCountStillReachesDestination() {
        let destination = CGPoint(x: 40, y: 50)

        XCTAssertEqual(
            PointerMotionPath.points(from: .zero, to: destination, steps: 0),
            [destination]
        )
        XCTAssertEqual(
            PointerMotionPath.points(from: .zero, to: destination, steps: -2),
            [destination]
        )
    }
}
