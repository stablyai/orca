import CoreFoundation
import Foundation
import XCTest
@testable import OrcaComputerUseMacOSCore

final class AttributeValueCoercionTests: XCTestCase {

    func testIntegerDecimalConversionIsExactAboveDoublePrecision() {
        let coercion = AttributeValueCoercion(
            existingValue: NSNumber(value: Int64(1)),
            requested: "9007199254740993.0"
        )

        XCTAssertEqual(coercion.writeValue, .integer(9_007_199_254_740_993))
        XCTAssertEqual(
            coercion.compare(readback: NSNumber(value: Int64(9_007_199_254_740_992))),
            .mismatch(actualPreview: "9007199254740992")
        )
    }

    func testIntegerScientificNotationIsParsedExactly() {
        let cases: [(String, Int64)] = [
            ("1e3", 1_000),
            ("9.007199254740993e15", 9_007_199_254_740_993),
            ("10.0e-1", 1),
            ("+0.000E999999999999999999999", 0),
            ("-.0e-999999999999999999999", 0),
        ]

        for (requested, expected) in cases {
            XCTAssertEqual(
                AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: requested).writeValue,
                .integer(expected)
            )
        }
    }

    func testIntegerParsingPreservesInt64Boundaries() {
        XCTAssertEqual(
            AttributeValueCoercion(
                existingValue: NSNumber(value: 1),
                requested: "9223372036854775807.0"
            ).writeValue,
            .integer(.max)
        )
        XCTAssertEqual(
            AttributeValueCoercion(
                existingValue: NSNumber(value: 1),
                requested: "-9.223372036854775808e18"
            ).writeValue,
            .integer(.min)
        )
    }

    func testNonIntegralAndOutOfRangeIntegerFormsUseStringFallback() {
        for requested in ["1e-1", "9223372036854775808", "-9223372036854775809", "1e999999999999999999999"] {
            XCTAssertEqual(
                AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: requested).writeValue,
                .string(requested)
            )
        }
    }

}
