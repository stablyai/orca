import Foundation

/// Truncate like Int(Double), but refuse non-finite/out-of-range values so malformed requests cannot crash the agent.
public func boundedInteger<T: BinaryInteger>(_ value: Double, as type: T.Type = T.self) -> T? {
    T(exactly: value.rounded(.towardZero))
}
