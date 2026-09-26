public enum ChromiumAccessibilityPolicy {
    public static func needsManualAccessibilityMode(bundleId: String?) -> Bool {
        // Chromium/Electron apps often need this private AX mode, but applying it
        // broadly can corrupt native Cocoa app trees into app-root-only nodes.
        guard let bundleId = bundleId?.lowercased() else {
            return false
        }
        return bundleId.hasPrefix("com.google.chrome") ||
            bundleId.hasPrefix("com.microsoft.edgemac") ||
            bundleId.hasPrefix("com.brave.browser") ||
            bundleId.hasPrefix("com.operasoftware.opera") ||
            bundleId.hasPrefix("com.vivaldi.vivaldi") ||
            bundleId == "com.github.electron" ||
            bundleId == "com.stablyai.orca" ||
            bundleId == "com.stablyai.orca.dev" ||
            bundleId == "com.tinyspeck.slackmacgap" ||
            bundleId == "com.spotify.client" ||
            bundleId == "com.hnc.discord" ||
            bundleId == "com.microsoft.teams2" ||
            bundleId == "notion.id"
    }
}
