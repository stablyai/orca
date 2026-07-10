public struct ActionArgumentValidationError: Error, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

public enum ActionArgumentValidation {
    public static func positiveInteger(
        _ value: Double?,
        defaultValue: Int,
        name: String
    ) -> Result<Int, ActionArgumentValidationError> {
        guard let value else { return .success(defaultValue) }
        guard value.isFinite, value > 0, let parsed = boundedInteger(value, as: Int.self) else {
            return .failure(ActionArgumentValidationError("\(name) must be a positive integer"))
        }
        return .success(parsed)
    }

    public static func positiveNumber(
        _ value: Double?,
        defaultValue: Double,
        name: String
    ) -> Result<Double, ActionArgumentValidationError> {
        guard let value else { return .success(defaultValue) }
        guard value.isFinite, value > 0 else {
            return .failure(ActionArgumentValidationError("\(name) must be a positive number"))
        }
        return .success(value)
    }

    public static func scrollDirection(_ value: String) -> Result<String, ActionArgumentValidationError> {
        switch value {
        case "up", "down", "left", "right":
            return .success(value)
        default:
            return .failure(ActionArgumentValidationError("unsupported scroll direction: \(value)"))
        }
    }
}
