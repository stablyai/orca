public struct AgentLaunchArguments: Equatable, Sendable {
    public let socketPath: String
    public let tokenFilePath: String
    public let expectedPeerProcessId: Int32

    public static func parse(_ arguments: [String]) -> AgentLaunchArguments? {
        guard arguments.count == 6,
              arguments[0] == "--agent",
              !arguments[1].isEmpty,
              arguments[2] == "--token-file",
              !arguments[3].isEmpty,
              arguments[4] == "--peer-pid",
              let expectedPeerProcessId = Int32(arguments[5]),
              expectedPeerProcessId > 0
        else {
            return nil
        }
        return AgentLaunchArguments(
            socketPath: arguments[1],
            tokenFilePath: arguments[3],
            expectedPeerProcessId: expectedPeerProcessId
        )
    }
}

public func isAuthorizedAgentPeer(
    peerProcessId: Int32?,
    expectedProcessId: Int32
) -> Bool {
    expectedProcessId > 0 && peerProcessId == expectedProcessId
}
