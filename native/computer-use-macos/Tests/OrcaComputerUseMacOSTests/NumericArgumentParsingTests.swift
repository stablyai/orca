import XCTest
@testable import OrcaComputerUseMacOSCore

final class NumericArgumentParsingTests: XCTestCase {


    // Int(1e300) traps despite being finite; malformed requests must not crash the agent.
    func testReturnsNilForOutOfRangeValues() {
        XCTAssertNil(boundedInteger(1e300, as: Int.self))
        XCTAssertNil(boundedInteger(-1e300, as: Int.self))
    }
}
