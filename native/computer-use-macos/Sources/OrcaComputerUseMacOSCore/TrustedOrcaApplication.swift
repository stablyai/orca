/// Bundle ids of the apps whose computer-use sidecar may drive this helper.
public enum TrustedOrcaApplication {
    public static func isTrusted(bundleId: String) -> Bool {
        // Why: `pnpm dev` launches as `com.stablyai.orca.dev` and per-worktree wrapper apps use
        // `com.stablyai.orca.dev.<name>`; the sidecar peer check must authorize both (#26498).
        // Zotz: must match appId in config/electron-builder.config.cjs.
        bundleId == "dev.hugorodriguez.zotz" ||
            bundleId == "com.stablyai.orca" ||
            bundleId == "com.stablyai.orca.dev" ||
            bundleId.hasPrefix("com.stablyai.orca.dev.") ||
            bundleId == "com.github.Electron"
    }
}
