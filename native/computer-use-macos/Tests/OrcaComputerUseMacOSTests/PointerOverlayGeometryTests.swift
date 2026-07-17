import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class PointerOverlayGeometryTests: XCTestCase {
    func testConvertsQuartzTopLeftCoordinatesToAppKitWindowOrigin() {
        XCTAssertEqual(
            PointerOverlayGeometry.windowOrigin(
                forQuartzPoint: CGPoint(x: 500, y: 300),
                primaryDisplayMaxY: 1080,
                hotSpot: CGPoint(x: 20, y: 44)
            ),
            CGPoint(x: 480, y: 736)
        )
    }

    func testPreservesCoordinatesAcrossDisplaysAboveThePrimaryScreen() {
        XCTAssertEqual(
            PointerOverlayGeometry.windowOrigin(
                forQuartzPoint: CGPoint(x: -200, y: -150),
                primaryDisplayMaxY: 1080,
                hotSpot: CGPoint(x: 20, y: 44)
            ),
            CGPoint(x: -220, y: 1186)
        )
    }
}
