public struct AgentSessionOwnership: Sendable {
    private var authenticatedConnections: Set<Int32> = []
    private var wasClaimed = false

    public init() {}

    public mutating func registerConnection(_ connection: Int32, authenticated: Bool) -> Bool {
        guard authenticated else { return false }
        let inserted = authenticatedConnections.insert(connection).inserted
        guard inserted, !wasClaimed else { return false }
        wasClaimed = true
        return true
    }

    public mutating func disconnect(_ connection: Int32) -> Bool {
        guard authenticatedConnections.remove(connection) != nil else { return false }
        return wasClaimed && authenticatedConnections.isEmpty
    }
}
