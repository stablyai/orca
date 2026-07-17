public enum AgentConnectionOwnership {
    public static func shouldClaim(
        method: String,
        requestToken: String?,
        expectedToken: String?,
        authorizedPeer: Bool
    ) -> Bool {
        guard authorizedPeer, method == "handshake" else {
            return false
        }
        guard let expectedToken else {
            return true
        }
        return requestToken == expectedToken
    }
}
