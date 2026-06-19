import Foundation

/// Converts a JSON-derived number to a fixed-width integer, truncating toward
/// zero like `Int(Double)` does, but returning nil instead of trapping when the
/// value is non-finite or outside the destination type's range. A malformed
/// request (e.g. `elementIndex: 1e300`) would otherwise crash the whole agent
/// process on the unchecked `Int(Double)` cast.
public func boundedInteger<T: BinaryInteger>(_ value: Double, as type: T.Type = T.self) -> T? {
    T(exactly: value.rounded(.towardZero))
}
