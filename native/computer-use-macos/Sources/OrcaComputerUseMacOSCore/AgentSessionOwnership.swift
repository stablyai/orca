public enum AgentSessionRegistration: Sendable, Equatable {
    case rejected
    case sessionReleased
    case joined
    case claimed
}

public struct AgentSessionOwnership: Sendable {
    private var authenticatedConnections: Set<Int32> = []
    private var wasClaimed = false
    private var wasReleased = false

    public init() {}

    public mutating func registerConnection(
        _ connection: Int32,
        authenticated: Bool
    ) -> AgentSessionRegistration {
        guard authenticated else { return .rejected }
        guard !wasReleased else { return .sessionReleased }
        let inserted = authenticatedConnections.insert(connection).inserted
        guard inserted, !wasClaimed else { return .joined }
        wasClaimed = true
        return .claimed
    }

    public mutating func disconnect(_ connection: Int32) -> Bool {
        guard authenticatedConnections.remove(connection) != nil else { return false }
        let released = wasClaimed && authenticatedConnections.isEmpty
        if released {
            wasReleased = true
        }
        return released
    }
}
