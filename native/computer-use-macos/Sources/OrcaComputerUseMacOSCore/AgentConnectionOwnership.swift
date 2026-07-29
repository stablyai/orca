import Foundation

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

public final class AgentConnectionOwnershipState: @unchecked Sendable {
    // Why: an older authenticated socket may disconnect after its replacement
    // connects, but only the latest owner may terminate the helper.
    private let lock = NSLock()
    private var nextGeneration: UInt64 = 0
    private var currentGeneration: UInt64?
    private var isTerminating = false

    public init() {}

    public func claim() -> UInt64? {
        lock.lock()
        defer { lock.unlock() }
        guard !isTerminating else { return nil }
        nextGeneration &+= 1
        currentGeneration = nextGeneration
        return nextGeneration
    }

    public func beginTermination(ifCurrent generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !isTerminating, currentGeneration == generation else {
            return false
        }
        isTerminating = true
        return true
    }
}
