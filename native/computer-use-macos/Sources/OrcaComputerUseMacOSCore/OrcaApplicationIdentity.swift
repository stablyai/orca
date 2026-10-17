public enum OrcaApplicationIdentity {
    public static func isTrustedAgentHost(bundleId: String) -> Bool {
        // The dev runner uses a stable identity so per-worktree builds share Keychain access.
        bundleId == "com.stablyai.orca" ||
            bundleId == "com.stablyai.orca.dev" ||
            bundleId.hasPrefix("com.stablyai.orca.dev.") ||
            bundleId == "com.github.Electron"
    }
}
