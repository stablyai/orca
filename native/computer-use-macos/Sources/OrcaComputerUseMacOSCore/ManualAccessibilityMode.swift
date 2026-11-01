import Foundation

public enum ManualAccessibilityMode {
    // Chromium/Electron and Gecko apps often need this private AX mode, but
    // applying it broadly can corrupt native Cocoa app trees into app-root-only
    // nodes, so it stays scoped to runtimes known to need it.
    public static func isRequired(bundleId: String?, bundleURL: URL?) -> Bool {
        if let bundleId = bundleId?.lowercased(), isAllowlisted(bundleId) {
            return true
        }
        return hasGeckoRuntime(bundleURL: bundleURL)
    }

    // Why: Gecko apps (Firefox, its forks, Zotero) expose only the window frame
    // until AXEnhancedUserInterface is set. They all ship the XUL library, so
    // detecting it covers forks without listing every bundle ID.
    public static func hasGeckoRuntime(
        bundleURL: URL?,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> Bool {
        guard let bundleURL else {
            return false
        }
        let xul = bundleURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent("XUL", isDirectory: false)
        return fileExists(xul.path)
    }

    private static func isAllowlisted(_ bundleId: String) -> Bool {
        bundleId.hasPrefix("com.google.chrome") ||
            bundleId.hasPrefix("com.microsoft.edgemac") ||
            bundleId.hasPrefix("com.brave.browser") ||
            bundleId.hasPrefix("com.operasoftware.opera") ||
            bundleId.hasPrefix("com.vivaldi.vivaldi") ||
            bundleId == "com.github.electron" ||
            bundleId == "com.tinyspeck.slackmacgap" ||
            bundleId == "com.spotify.client" ||
            bundleId == "com.hnc.discord" ||
            bundleId == "com.microsoft.teams2" ||
            bundleId == "notion.id"
    }
}
