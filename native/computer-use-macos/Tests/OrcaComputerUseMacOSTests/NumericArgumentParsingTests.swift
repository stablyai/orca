import XCTest
@testable import OrcaComputerUseMacOSCore

final class NumericArgumentParsingTests: XCTestCase {
    func testConvertsIntegralValues() {
        XCTAssertEqual(boundedInteger(5.0, as: Int.self), 5)
        XCTAssertEqual(boundedInteger(0.0, as: Int.self), 0)
        XCTAssertEqual(boundedInteger(-3.0, as: Int.self), -3)
    }

    func testTruncatesTowardZeroLikeIntInit() {
        XCTAssertEqual(boundedInteger(5.9, as: Int.self), 5)
        XCTAssertEqual(boundedInteger(-5.9, as: Int.self), -5)
    }

    // The crash this guards against: Int(1e300) traps because the value is
    // finite but outside Int's range. A malformed request must not take the
    // agent down.
    func testReturnsNilForOutOfRangeValues() {
        XCTAssertNil(boundedInteger(1e300, as: Int.self))
        XCTAssertNil(boundedInteger(-1e300, as: Int.self))
    }

    func testReturnsNilForNonFiniteValues() {
        XCTAssertNil(boundedInteger(.nan, as: Int.self))
        XCTAssertNil(boundedInteger(.infinity, as: Int.self))
        XCTAssertNil(boundedInteger(-.infinity, as: Int.self))
    }

    func testHonorsUnsignedDestinationBounds() {
        XCTAssertEqual(boundedInteger(4.0, as: UInt32.self), 4)
        XCTAssertNil(boundedInteger(-1.0, as: UInt32.self))
        XCTAssertNil(boundedInteger(1e300, as: UInt32.self))
    }

    func testHonorsSignedFixedWidthDestinationBounds() {
        XCTAssertEqual(boundedInteger(Double(Int32.max), as: Int32.self), Int32.max)
        XCTAssertNil(boundedInteger(Double(Int32.max) + 1, as: Int32.self))
        XCTAssertNil(boundedInteger(Double(Int32.min) - 1, as: Int32.self))
    }
}
