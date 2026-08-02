import OrcaComputerUseMacOSCore
import XCTest

final class ActionArgumentValidationTests: XCTestCase {
    func testPositiveIntegerAcceptsPositiveValuesAndDefaults() {
        XCTAssertEqual(
            try ActionArgumentValidation.positiveInteger(nil, defaultValue: 1, name: "clickCount").get(),
            1
        )
        XCTAssertEqual(
            try ActionArgumentValidation.positiveInteger(2, defaultValue: 1, name: "clickCount").get(),
            2
        )
    }

    func testPositiveIntegerRejectsZeroNegativeAndNonFiniteValues() {
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveInteger(0, defaultValue: 1, name: "clickCount")),
            "clickCount must be a positive integer"
        )
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveInteger(-1, defaultValue: 1, name: "clickCount")),
            "clickCount must be a positive integer"
        )
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveInteger(.infinity, defaultValue: 1, name: "clickCount")),
            "clickCount must be a positive integer"
        )
    }

    func testPositiveNumberAcceptsPositiveValuesAndDefaults() {
        XCTAssertEqual(
            try ActionArgumentValidation.positiveNumber(nil, defaultValue: 1, name: "pages").get(),
            1
        )
        XCTAssertEqual(
            try ActionArgumentValidation.positiveNumber(0.5, defaultValue: 1, name: "pages").get(),
            0.5
        )
    }

    func testPositiveNumberRejectsZeroNegativeAndNonFiniteValues() {
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveNumber(0, defaultValue: 1, name: "pages")),
            "pages must be a positive number"
        )
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveNumber(-0.5, defaultValue: 1, name: "pages")),
            "pages must be a positive number"
        )
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.positiveNumber(.nan, defaultValue: 1, name: "pages")),
            "pages must be a positive number"
        )
    }

    func testScrollDirectionRejectsUnknownDirections() {
        XCTAssertEqual(try ActionArgumentValidation.scrollDirection("down").get(), "down")
        XCTAssertEqual(
            failureMessage(ActionArgumentValidation.scrollDirection("diagonal")),
            "unsupported scroll direction: diagonal"
        )
    }

    private func failureMessage<T>(_ result: Result<T, ActionArgumentValidationError>) -> String? {
        if case let .failure(error) = result {
            return error.message
        }
        return nil
    }
}
