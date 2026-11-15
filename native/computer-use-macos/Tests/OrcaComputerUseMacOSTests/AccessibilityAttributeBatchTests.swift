import ApplicationServices
import XCTest
@testable import OrcaComputerUseMacOSCore

final class AccessibilityAttributeBatchTests: XCTestCase {
    func testDecodeTreatsAXErrorAndNullSlotsAsMissingButKeepsOtherAXValues() throws {
        var noValue = AXError.noValue
        let errorSlot = try XCTUnwrap(AXValueCreate(.axError, &noValue))
        var point = CGPoint(x: 3, y: 4)
        let pointSlot = try XCTUnwrap(AXValueCreate(.cgPoint, &point))

        let decoded = try XCTUnwrap(AccessibilityAttributeBatch.decode(
            requested: ["AXTitle", "AXDescription", "AXPosition", "AXRole"],
            values: [errorSlot, kCFNull, pointSlot, "AXButton" as CFString]
        ))

        XCTAssertEqual(Set(decoded.keys), ["AXTitle", "AXDescription", "AXPosition", "AXRole"])
        XCTAssertNil(decoded["AXTitle"] ?? nil)
        XCTAssertNil(decoded["AXDescription"] ?? nil)
        XCTAssertEqual(decoded["AXRole"] as? String, "AXButton")
        var readPoint = CGPoint.zero
        let positionValue = try XCTUnwrap(decoded["AXPosition"] ?? nil)
        XCTAssertTrue(AXValueGetValue(positionValue as! AXValue, .cgPoint, &readPoint))
        XCTAssertEqual(readPoint, point)
    }

    func testDecodeRejectsAnArrayThatDoesNotLineUpSoTheWalkerFallsBackToSingleReads() {
        XCTAssertNil(AccessibilityAttributeBatch.decode(requested: ["AXRole", "AXTitle"], values: ["AXButton" as CFString]))
        XCTAssertNil(AccessibilityAttributeBatch.decode(requested: ["AXRole"], values: nil))
    }

    func testPrefetchOnlyAsksForAdvertisedAttributesAndNeverForTheValue() {
        let advertised: Set<String> = ["AXRole", "AXTitle", "AXValue", "AXChildren", "AXSomethingCustom"]

        XCTAssertEqual(AccessibilityAttributeBatch.attributesToPrefetch(advertised: advertised), ["AXRole", "AXTitle", "AXChildren"])
        XCTAssertEqual(AccessibilityAttributeBatch.attributesToPrefetch(advertised: nil), [])
    }
}
