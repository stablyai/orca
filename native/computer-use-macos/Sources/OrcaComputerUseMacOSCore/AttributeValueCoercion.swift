import CoreFoundation
import Foundation

public struct AttributeValueCoercion: Equatable {
    public enum Value: Equatable {
        case string(String)
        case integer(Int64)
        case double(Double)
        case boolean(Bool)

        public var preview: String {
            switch self {
            case let .string(value):
                return value
            case let .integer(value):
                return String(value)
            case let .double(value):
                return String(value)
            case let .boolean(value):
                return String(value)
            }
        }
    }

    public enum ReadbackComparison: Equatable {
        case match(actualPreview: String)
        case mismatch(actualPreview: String)
        case unsupported
    }

    public let writeValue: Value

    public init(existingValue: CFTypeRef?, requested: String) {
        guard let existingValue, let current = Self.decode(existingValue) else {
            writeValue = .string(requested)
            return
        }

        writeValue = Self.coerce(requested, matching: current) ?? .string(requested)
    }

    public func compare(readback: CFTypeRef?) -> ReadbackComparison {
        guard let readback, let actual = Self.decode(readback) else {
            return .unsupported
        }
        return actual == writeValue
            ? .match(actualPreview: actual.preview)
            : .mismatch(actualPreview: actual.preview)
    }

    private static func coerce(_ requested: String, matching current: Value) -> Value? {
        let trimmed = requested.trimmingCharacters(in: .whitespacesAndNewlines)
        switch current {
        case .string:
            return .string(requested)
        case .integer:
            return parseInteger(trimmed).map(Value.integer)
        case .double:
            guard let value = Double(trimmed), value.isFinite else { return nil }
            return .double(value)
        case .boolean:
            switch trimmed.lowercased() {
            case "true", "1":
                return .boolean(true)
            case "false", "0":
                return .boolean(false)
            default:
                return nil
            }
        }
    }

    private static func parseInteger(_ value: String) -> Int64? {
        if let integer = Int64(value) {
            return integer
        }

        var unsigned = value[...]
        let isNegative = unsigned.first == "-"
        if isNegative || unsigned.first == "+" {
            unsigned = unsigned.dropFirst()
        }

        let exponentIndex = unsigned.firstIndex { $0 == "e" || $0 == "E" }
        let significand = exponentIndex.map { unsigned[..<$0] } ?? unsigned
        let exponentText = exponentIndex.map { unsigned[unsigned.index(after: $0)...] }
        guard exponentText?.contains(where: { $0 == "e" || $0 == "E" }) != true else { return nil }

        let exponent: Int?
        if let exponentText {
            let digits = exponentText.first == "+" || exponentText.first == "-"
                ? exponentText.dropFirst()
                : exponentText
            guard !digits.isEmpty, digits.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
                return nil
            }
            exponent = Int(exponentText)
        } else {
            exponent = 0
        }

        let parts = significand.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        let whole = parts[0]
        let fraction = parts.count == 2 ? parts[1] : Substring()
        guard !whole.isEmpty || !fraction.isEmpty,
              whole.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              fraction.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 })
        else {
            return nil
        }

        let digits = whole + fraction
        let significant = digits.drop(while: { $0 == "0" })
        guard !significant.isEmpty else { return 0 }
        guard let exponent else { return nil }

        let trailingZeroCount = significant.reversed().prefix(while: { $0 == "0" }).count
        let normalized: String
        if exponent >= fraction.count {
            let zeroCount = exponent - fraction.count
            guard significant.count <= 19, zeroCount <= 19 - significant.count else { return nil }
            normalized = String(significant) + String(repeating: "0", count: zeroCount)
        } else {
            let removedCount: Int
            if exponent >= 0 {
                removedCount = fraction.count - exponent
            } else {
                guard fraction.count <= trailingZeroCount,
                      exponent.magnitude <= UInt(trailingZeroCount - fraction.count)
                else {
                    return nil
                }
                removedCount = fraction.count + Int(exponent.magnitude)
            }
            guard removedCount <= trailingZeroCount else { return nil }
            normalized = String(significant.dropLast(removedCount))
        }

        return Int64(isNegative ? "-\(normalized)" : normalized)
    }

    private static func decode(_ value: CFTypeRef) -> Value? {
        let typeID = CFGetTypeID(value)
        if typeID == CFStringGetTypeID() {
            return (value as? String).map(Value.string)
        }
        if typeID == CFBooleanGetTypeID() {
            return (value as? Bool).map(Value.boolean)
        }
        guard typeID == CFNumberGetTypeID() else { return nil }

        guard let bridgedNumber = value as? NSNumber else { return nil }
        let number = bridgedNumber as CFNumber
        if CFNumberIsFloatType(number) {
            var decoded = 0.0
            guard CFNumberGetValue(number, .doubleType, &decoded), decoded.isFinite else { return nil }
            return .double(decoded)
        }

        var decoded: Int64 = 0
        guard CFNumberGetValue(number, .sInt64Type, &decoded) else { return nil }
        return .integer(decoded)
    }
}
