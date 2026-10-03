import OrcaComputerUseMacOSCore
import XCTest

final class ManualAccessibilityModeTests: XCTestCase {
    func testKeepsChromiumAndElectronAllowlist() {
        XCTAssertTrue(ManualAccessibilityMode.isRequired(bundleId: "com.google.Chrome", bundleURL: nil))
        XCTAssertTrue(ManualAccessibilityMode.isRequired(bundleId: "com.tinyspeck.slackmacgap", bundleURL: nil))
    }

    func testSkipsNativeCocoaAppsWithoutGeckoRuntime() {
        let finder = URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app", isDirectory: true)
        XCTAssertFalse(ManualAccessibilityMode.isRequired(bundleId: "com.apple.finder", bundleURL: finder))
        XCTAssertFalse(ManualAccessibilityMode.isRequired(bundleId: nil, bundleURL: nil))
    }

    func testDetectsGeckoAppsByTheirXULLibrary() {
        let zotero = URL(fileURLWithPath: "/Applications/Zotero.app", isDirectory: true)
        var checkedPath: String?
        let detected = ManualAccessibilityMode.hasGeckoRuntime(bundleURL: zotero) { path in
            checkedPath = path
            return true
        }

        XCTAssertTrue(detected)
        XCTAssertEqual(checkedPath, "/Applications/Zotero.app/Contents/MacOS/XUL")
    }

    func testRequiresModeForGeckoAppOutsideTheAllowlist() throws {
        let bundle = FileManager.default.temporaryDirectory
            .appendingPathComponent("orca-gecko-\(UUID().uuidString).app", isDirectory: true)
        let macOS = bundle.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundle) }

        XCTAssertFalse(ManualAccessibilityMode.isRequired(bundleId: "org.zotero.zotero", bundleURL: bundle))
        FileManager.default.createFile(atPath: macOS.appendingPathComponent("XUL").path, contents: Data())
        XCTAssertTrue(ManualAccessibilityMode.isRequired(bundleId: "org.zotero.zotero", bundleURL: bundle))
    }
}
