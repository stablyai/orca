import CoreFoundation
import Foundation
import XCTest
@testable import OrcaComputerUseMacOSCore

final class AttributeValueCoercionTests: XCTestCase {
    func testStringValueRemainsAStringWithoutTrimming() {
        let coercion = AttributeValueCoercion(existingValue: "old" as CFString, requested: "  new  ")

        XCTAssertEqual(coercion.writeValue, .string("  new  "))
    }

    func testIntegerValuePreservesIntegerKind() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: Int32(2)), requested: "3.0")

        XCTAssertEqual(coercion.writeValue, .integer(3))
    }

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

    func testDoubleValuePreservesDoubleKindForIntegralInput() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: 2.5), requested: "3")

        XCTAssertEqual(coercion.writeValue, .double(3.0))
    }

    func testBooleanValueAcceptsWordsAndNumericAliases() {
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "TRUE").writeValue,
            .boolean(true)
        )
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: kCFBooleanTrue, requested: "0").writeValue,
            .boolean(false)
        )
    }

    func testUnreadableAndUnhandledValuesUseStringFallback() {
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: nil, requested: "7").writeValue,
            .string("7")
        )
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: [1, 2] as CFArray, requested: "7").writeValue,
            .string("7")
        )
    }

    func testInvalidHandledValuesUseStringFallback() {
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: NSNumber(value: 2), requested: "2.5").writeValue,
            .string("2.5")
        )
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: NSNumber(value: 2.5), requested: "many").writeValue,
            .string("many")
        )
        XCTAssertEqual(
            AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "maybe").writeValue,
            .string("maybe")
        )
    }

    func testReadbackMatchesEachSupportedType() {
        let cases: [(AttributeValueCoercion, CFTypeRef, String)] = [
            (AttributeValueCoercion(existingValue: "old" as CFString, requested: "new"), "new" as CFString, "new"),
            (AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: "2"), NSNumber(value: 2), "2"),
            (AttributeValueCoercion(existingValue: NSNumber(value: 1.5), requested: "2.5"), NSNumber(value: 2.5), "2.5"),
            (AttributeValueCoercion(existingValue: kCFBooleanFalse, requested: "true"), kCFBooleanTrue, "true"),
        ]

        for (coercion, readback, preview) in cases {
            XCTAssertEqual(coercion.compare(readback: readback), .match(actualPreview: preview))
        }
    }

    func testSupportedMismatchedReadbackIncludesActualPreview() {
        let coercion = AttributeValueCoercion(existingValue: NSNumber(value: 1), requested: "2")

        XCTAssertEqual(
            coercion.compare(readback: NSNumber(value: 3)),
            .mismatch(actualPreview: "3")
        )
    }

    func testUnreadableAndUnhandledReadbackAreUnsupported() {
        let coercion = AttributeValueCoercion(existingValue: "old" as CFString, requested: "new")

        XCTAssertEqual(coercion.compare(readback: nil), .unsupported)
        XCTAssertEqual(coercion.compare(readback: ["new"] as CFArray), .unsupported)
    }
}
