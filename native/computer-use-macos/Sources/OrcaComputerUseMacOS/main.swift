import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import OrcaComputerUseMacOSCore
import ScreenCaptureKit

private let providerName = "orca-computer-use-macos"
private let providerVersion = "1.0.0"
private let providerProtocolVersion = 1

struct Request: Decodable {
    let id: Int
    let method: String
    let params: [String: JSONValue]?
    let token: String?
}

enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

enum ProviderError: Error {
    case coded(String, String)

    var code: String {
        switch self {
        case let .coded(code, _):
            return code
        }
    }

    var message: String {
        switch self {
        case let .coded(_, message):
            return message
        }
    }
}

struct AppDescriptor {
    let name: String
    let bundleId: String?
    let pid: pid_t
    let app: NSRunningApplication

    var needsManualAccessibilityMode: Bool {
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
            bundleId == "com.tinyspeck.slackmacgap" ||
            bundleId == "com.spotify.client" ||
            bundleId == "com.hnc.discord" ||
            bundleId == "com.microsoft.teams2" ||
            bundleId == "notion.id"
    }
}

final class ElementRecord {
    let index: Int
    let element: AXUIElement
    let localFrame: CGRect?
    let actions: [String]
    let signature: String

    init(index: Int, element: AXUIElement, localFrame: CGRect?, actions: [String], signature: String) {
        self.index = index
        self.element = element
        self.localFrame = localFrame
        self.actions = actions
        self.signature = signature
    }
}

struct Snapshot {
    let id: String
    let app: AppDescriptor
    let windowTitle: String
    let windowBounds: CGRect
    let windowId: CGWindowID
    let windowLayer: Int
    let treeText: String
    let focusedElementId: Int?
    let screenshot: ScreenshotPayload?
    let screenshotStatus: ScreenshotStatus
    let screenshotScale: CGSize
    let screenshotEngine: String?
    let elements: [Int: ElementRecord]
    let truncated: Bool
    let maxDepthReached: Bool
}

struct ScreenshotPayload {
    let data: String
    let width: Int
    let height: Int
    let scale: Double
}

struct CapturedImage {
    let image: CGImage
    let engine: String
}

enum ScreenshotStatus {
    case captured
    case skipped
    case failed(String)
}

final class Provider {
    private var snapshots: [String: Snapshot] = [:]
    private var hasPromptedForAccessibility = false

    func handle(method: String, params: [String: JSONValue]) throws -> Any {
        switch method {
        case "handshake":
            return providerHandshake()
        case "listApps":
            return ["apps": listApps().map(renderListedApp)]
        case "listWindows":
            return try listWindows(params: params)
        case "getAppState":
            return try renderSnapshot(observe(params: params))
        case "click":
            return try actionResult(params: params) { try click(params: params) }
        case "performSecondaryAction":
            return try actionResult(params: params) { try performSecondaryAction(params: params) }
        case "setValue":
            return try actionResult(params: params) { try setValue(params: params) }
        case "typeText":
            return try actionResult(params: params) { try typeText(params: params) }
        case "pressKey":
            return try actionResult(params: params) { try pressKey(params: params) }
        case "hotkey":
            return try actionResult(params: params) { try hotkey(params: params) }
        case "pasteText":
            return try actionResult(params: params) { try pasteText(params: params) }
        case "scroll":
            return try actionResult(params: params) { try scroll(params: params) }
        case "drag":
            return try actionResult(params: params) { try drag(params: params) }
        default:
            throw ProviderError.coded("invalid_argument", "unknown method '\(method)'")
        }
    }

    private func actionResult(params: [String: JSONValue], action runAction: () throws -> [String: Any]) throws -> [String: Any] {
        var action = try runAction()
        do {
            return try renderActionResult(action: action, snapshot: observe(params: params))
        } catch let error as ProviderError where (error.code == "window_not_found" || error.code == "window_stale") && (requestedWindowId(params) != nil || requestedWindowIndex(params) != nil) {
            var fallbackParams = params
            fallbackParams.removeValue(forKey: "windowId")
            fallbackParams.removeValue(forKey: "windowIndex")
            if action["verification"] == nil {
                action["verification"] = ["state": "unverified", "reason": "window_changed"]
            }
            return try renderActionResult(action: action, snapshot: observe(params: fallbackParams))
        }
    }

    private func observe(params: [String: JSONValue]) throws -> Snapshot {
        let query = try requiredString(params, "app")
        let app = try resolveApp(query)
        if params["restoreWindow"]?.bool == true {
            recoverWindow(app)
        }
        let snapshot = try buildSnapshot(
            app: app,
            includeScreenshot: params["noScreenshot"]?.bool != true,
            windowId: requestedWindowId(params),
            windowIndex: requestedWindowIndex(params),
            restoreWindow: params["restoreWindow"]?.bool == true
        )
        let keys = [query, app.name, app.bundleId ?? ""].filter { !$0.isEmpty }.map { $0.lowercased() }
        let namespace = snapshotNamespace(params)
        for key in keys {
            if !isExplicitSnapshotNamespace(namespace) {
                snapshots[key] = snapshot
                snapshots[snapshotWindowKey(key, snapshot.windowId)] = snapshot
                if let windowIndex = requestedWindowIndex(params) {
                    snapshots[snapshotWindowIndexKey(key, windowIndex)] = snapshot
                }
            }
            snapshots[namespacedSnapshotKey(namespace, key)] = snapshot
            snapshots[namespacedSnapshotKey(namespace, snapshotWindowKey(key, snapshot.windowId))] = snapshot
            if let windowIndex = requestedWindowIndex(params) {
                snapshots[namespacedSnapshotKey(namespace, snapshotWindowIndexKey(key, windowIndex))] = snapshot
            }
        }
        return snapshot
    }

    private func currentSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        let cached = cachedSnapshot(params: params)
        // Why: cached AX frames can be stale after a window move or resize, and
        // stale geometry can turn an intended action into a misclick.
        let snapshot = try observe(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
        try validateRequestedElements(cached: cached, current: snapshot, params: params)
        return snapshot
    }

    private func currentKeyboardSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        let snapshot = try currentSnapshot(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
        if params["restoreWindow"]?.bool != true && !isTargetWindowFocused(snapshot) {
            throw ProviderError.coded("window_not_focused", "keyboard input requires the target \(snapshot.app.name) window to be focused; retry with --restore-window or use set-value for editable elements")
        }
        return snapshot
    }

    private func cachedSnapshot(params: [String: JSONValue]) -> Snapshot? {
        guard let query = params["app"]?.string, !query.isEmpty else { return nil }
        let namespace = snapshotNamespace(params)
        if let targetWindowId = requestedWindowId(params) {
            let windowKey = snapshotWindowKey(query.lowercased(), targetWindowId)
            return snapshots[namespacedSnapshotKey(namespace, windowKey)] ??
                (isExplicitSnapshotNamespace(namespace) ? nil : snapshots[windowKey])
        }
        if let targetWindowIndex = requestedWindowIndex(params) {
            let windowKey = snapshotWindowIndexKey(query.lowercased(), targetWindowIndex)
            return snapshots[namespacedSnapshotKey(namespace, windowKey)] ??
                (isExplicitSnapshotNamespace(namespace) ? nil : snapshots[windowKey])
        }
        let key = query.lowercased()
        return snapshots[namespacedSnapshotKey(namespace, key)] ??
            (isExplicitSnapshotNamespace(namespace) ? nil : snapshots[key])
    }

    private func validateRequestedElements(cached: Snapshot?, current: Snapshot, params: [String: JSONValue]) throws {
        let requestedKeys = ["elementIndex", "fromElementIndex", "toElementIndex"].filter {
            params[$0]?.number != nil
        }
        guard !requestedKeys.isEmpty else { return }
        guard let cached else {
            throw ProviderError.coded("element_not_found", "element indexes require a fresh get-app-state snapshot for this app/window")
        }
        for key in requestedKeys {
            guard let value = params[key]?.number else { continue }
            let index = Int(value)
            guard let expected = cached.elements[index], let actual = current.elements[index] else {
                throw ProviderError.coded("element_not_found", "element \(index) is stale; run get-app-state again and use a fresh element index")
            }
            guard expected.signature == actual.signature else {
                throw ProviderError.coded("element_not_found", "element \(index) changed since the last snapshot; run get-app-state again and use a fresh element index")
            }
        }
    }

    private func ensureWindowStillAvailable(_ snapshot: Snapshot) throws {
        guard WindowCapture.candidates(pid: snapshot.app.pid).contains(where: { $0.windowId == snapshot.windowId }) else {
            throw ProviderError.coded("window_stale", "window \(Int(snapshot.windowId)) is no longer available; run get-app-state again to refresh the target window")
        }
    }

    private func promptForAccessibilityOnce() {
        guard !hasPromptedForAccessibility else {
            return
        }
        hasPromptedForAccessibility = true
        _ = promptForAccessibility()
    }

    private func listApps() -> [AppDescriptor] {
        var seen = Set<String>()
        return NSWorkspace.shared.runningApplications
            .filter { !$0.isTerminated && $0.activationPolicy == .regular }
            .compactMap { app in
                guard let name = app.localizedName, !name.isEmpty else { return nil }
                let pid = app.processIdentifier
                guard pid > 0, pidIsLive(pid) else { return nil }
                let key = (app.bundleIdentifier ?? "pid:\(pid)").lowercased()
                guard seen.insert(key).inserted else { return nil }
                return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
            }
            .sorted { lhs, rhs in
                if lhs.app.isActive != rhs.app.isActive {
                    return lhs.app.isActive && !rhs.app.isActive
                }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    private func renderListedApp(_ app: AppDescriptor) -> [String: Any] {
        [
            "name": app.name,
            "bundleId": jsonNullable(app.bundleId),
            "pid": Int(app.pid),
            "isRunning": true,
            "lastUsedAt": NSNull(),
            "useCount": NSNull(),
        ]
    }

    private func providerHandshake() -> [String: Any] {
        [
            "platform": "darwin",
            "provider": providerName,
            "providerVersion": providerVersion,
            "protocolVersion": providerProtocolVersion,
            "supports": [
                "apps": [
                    "list": true,
                    "bundleIds": true,
                    "pids": true,
                ],
                "windows": [
                    "list": true,
                    "targetById": true,
                    "targetByIndex": true,
                    "focus": false,
                    "moveResize": false,
                ],
                "observation": [
                    "screenshot": true,
                    "annotatedScreenshot": false,
                    "elementFrames": true,
                    "ocr": false,
                ],
                "actions": [
                    "click": true,
                    "typeText": true,
                    "pressKey": true,
                    "hotkey": true,
                    "pasteText": true,
                    "scroll": true,
                    "drag": true,
                    "setValue": true,
                    "performAction": true,
                ],
                "surfaces": [
                    "menus": false,
                    "dialogs": false,
                    "dock": false,
                    "menubar": false,
                ],
            ],
        ]
    }

    private func resolveApp(_ query: String) throws -> AppDescriptor {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ProviderError.coded("invalid_argument", "app query must not be empty")
        }
        if let pid = parsePid(trimmed) {
            if let app = appByPid(pid) {
                try rejectBlockedApp(app)
                return app
            }
            throw ProviderError.coded("app_not_found", "app '\(trimmed)' not found")
        }
        if blockedBundleIds.contains(trimmed) {
            throw ProviderError.coded("app_blocked", "app '\(trimmed)' is blocked for safety")
        }
        if let app = listApps().first(where: { matches($0, query: trimmed) }) {
            try rejectBlockedApp(app)
            return app
        }
        throw ProviderError.coded("app_not_found", "app '\(trimmed)' not found")
    }

    private func rejectBlockedApp(_ app: AppDescriptor) throws {
        if let bundle = app.bundleId, blockedBundleIds.contains(bundle) {
            throw ProviderError.coded("app_blocked", "app '\(bundle)' is blocked for safety")
        }
    }

    private func listWindows(params: [String: JSONValue]) throws -> [String: Any] {
        let app = try resolveApp(try requiredString(params, "app"))
        let windows = WindowCapture.candidates(pid: app.pid)
            .filter { $0.layer == 0 }
            .enumerated()
            .map { index, candidate -> [String: Any] in
                [
                    "index": index,
                    "app": [
                        "name": app.name,
                        "bundleId": jsonNullable(app.bundleId),
                        "pid": Int(app.pid),
                    ],
                    "id": Int(candidate.windowId),
                    "title": candidate.title ?? "",
                    "x": Int(candidate.bounds.origin.x.rounded()),
                    "y": Int(candidate.bounds.origin.y.rounded()),
                    "width": Int(candidate.bounds.width.rounded()),
                    "height": Int(candidate.bounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": !candidate.isOnScreen,
                    "screenIndex": jsonNullable(screenIndex(for: candidate.bounds)),
                    "isMain": NSNull(),
                    "platform": [
                        "layer": candidate.layer,
                        "alpha": candidate.alpha,
                    ],
                ]
            }
        return [
            "app": renderListedApp(app),
            "windows": windows,
        ]
    }

    private func appByPid(_ pid: pid_t) -> AppDescriptor? {
        guard let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated,
              let name = app.localizedName
        else {
            return nil
        }
        return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
    }

    private func buildSnapshot(
        app: AppDescriptor,
        includeScreenshot: Bool,
        windowId: CGWindowID?,
        windowIndex: Int?,
        restoreWindow: Bool
    ) throws -> Snapshot {
        guard accessibilityTrusted() else {
            promptForAccessibilityOnce()
            throw ProviderError.coded("permission_denied", "Accessibility permission is required for Orca Computer Use.")
        }
        let appElement = AXUIElementCreateApplication(app.pid)
        enableManualAccessibilityIfNeeded(appElement, app: app)
        let windowCandidates = WindowCapture.candidates(pid: app.pid)
        let focused = try focusedWindow(
            appElement: appElement,
            app: app,
            visibleWindowCount: windowCandidates.count,
            allowRecovery: restoreWindow
        )
        let focusedTitle = stringAttribute(focused, kAXTitleAttribute as String) ?? app.name
        guard let capture = WindowCapture.resolve(candidates: windowCandidates, titleHint: focusedTitle, windowId: windowId, windowIndex: windowIndex) else {
            throw ProviderError.coded("window_not_found", "app '\(app.name)' has no on-screen window")
        }
        guard let window = matchingWindow(appElement: appElement, capture: capture, focused: focused, explicitTarget: windowId != nil || windowIndex != nil) else {
            throw ProviderError.coded("window_not_found", "could not match accessibility window to requested window; run get-app-state again or retry without a window selector")
        }
        let title = stringAttribute(window, kAXTitleAttribute as String) ?? capture.title ?? app.name
        let renderer = TreeRenderer(windowBounds: capture.bounds, focused: focusedElement(appElement: appElement))
        renderer.render(window)
        let screenshot = includeScreenshot ? capture.screenshotPayload() : nil
        let screenshotStatus: ScreenshotStatus = if screenshot != nil {
            .captured
        } else if includeScreenshot && !screenCaptureTrusted() {
            .failed("Screen Recording permission is required for Orca Computer Use; grant permission or pass --no-screenshot to inspect accessibility state only.")
        } else if includeScreenshot {
            .failed("window screenshot capture returned no image; retry with --no-screenshot if accessibility state is sufficient.")
        } else {
            .skipped
        }
        return Snapshot(
            id: UUID().uuidString,
            app: app,
            windowTitle: title,
            windowBounds: capture.bounds,
            windowId: capture.windowId,
            windowLayer: capture.layer,
            treeText: renderTreeText(app: app, title: title, bounds: capture.bounds, lines: renderer.lines, focused: renderer.focusedSummary),
            focusedElementId: renderer.focusedElementId,
            screenshot: screenshot,
            screenshotStatus: screenshotStatus,
            screenshotScale: screenshotScale(screenshot: screenshot, bounds: capture.bounds),
            screenshotEngine: capture.image?.engine,
            elements: renderer.records,
            truncated: renderer.truncated,
            maxDepthReached: renderer.maxDepthReached
        )
    }

    private func renderSnapshot(_ snapshot: Snapshot) -> [String: Any] {
        var screenshot: Any = NSNull()
        if let payload = snapshot.screenshot {
            screenshot = [
                "data": payload.data,
                "format": "png",
                "width": payload.width,
                "height": payload.height,
                "scale": payload.scale,
            ]
        }
        return [
            "snapshot": [
                "id": snapshot.id,
                "app": [
                    "name": snapshot.app.name,
                    "bundleId": jsonNullable(snapshot.app.bundleId),
                    "pid": Int(snapshot.app.pid),
                ],
                "window": [
                    "id": Int(snapshot.windowId),
                    "title": snapshot.windowTitle,
                    "x": Int(snapshot.windowBounds.origin.x.rounded()),
                    "y": Int(snapshot.windowBounds.origin.y.rounded()),
                    "width": Int(snapshot.windowBounds.width.rounded()),
                    "height": Int(snapshot.windowBounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": false,
                    "screenIndex": jsonNullable(screenIndex(for: snapshot.windowBounds)),
                    "platform": [
                        "layer": snapshot.windowLayer,
                    ],
                ],
                "coordinateSpace": "window",
                "treeText": snapshot.treeText,
                "elementCount": snapshot.elements.count,
                "focusedElementId": snapshot.focusedElementId as Any,
                "truncation": [
                    "truncated": snapshot.truncated,
                    "maxNodes": TreeRenderer.maxNodes,
                    "maxDepth": TreeRenderer.maxDepth,
                    "maxDepthReached": snapshot.maxDepthReached,
                ],
            ],
            "screenshot": screenshot,
            "screenshotStatus": renderScreenshotStatus(snapshot.screenshotStatus, snapshot: snapshot),
        ]
    }

    private func renderActionResult(action: [String: Any], snapshot: Snapshot) -> [String: Any] {
        var result = renderSnapshot(snapshot)
        var metadata = action
        metadata["targetWindowId"] = Int(snapshot.windowId)
        result["action"] = metadata
        return result
    }

    private func click(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let button = params["mouseButton"]?.string ?? "left"
        let count = Int(params["clickCount"]?.number ?? 1)
        if let elementIndex = params["elementIndex"]?.number {
            let record = try element(snapshot, Int(elementIndex))
            if count <= 1, let actionName = try performClickAction(record: record, mouseButton: button) {
                return actionMetadata(path: "accessibility", actionName: actionName)
            }
            if let point = center(record.localFrame, in: snapshot.windowBounds) {
                try Input.click(
                    pid: snapshot.app.pid,
                    at: point,
                    button: mouseButton(button),
                    count: count
                )
                return actionMetadata(path: "synthetic", fallbackReason: "actionUnsupported")
            }
            throw ProviderError.coded("element_not_clickable", "element \(record.index) has no clickable frame")
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try Input.click(
            pid: snapshot.app.pid,
            at: point,
            button: mouseButton(button),
            count: count
        )
        return actionMetadata(path: "synthetic")
    }

    private func performClickAction(record: ElementRecord, mouseButton: String) throws -> String? {
        if mouseButton == "right" {
            return performAction(record.element, "AXShowMenu") ? "AXShowMenu" : nil
        }
        for action in ["AXPress", "AXConfirm", "AXOpen"] {
            if performAction(record.element, action) {
                return action
            }
        }
        return nil
    }

    private func performSecondaryAction(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, Int(try requiredNumber(params, "elementIndex")))
        let requested = try requiredString(params, "action")
        let action = record.actions.first { SnapshotRenderHeuristics.prettyAction($0).caseInsensitiveCompare(requested) == .orderedSame || $0.caseInsensitiveCompare(requested) == .orderedSame }
        guard let action else {
            throw ProviderError.coded("action_not_supported", "'\(requested)' is not a valid secondary action for element \(record.index)")
        }
        guard performAction(record.element, action) else {
            throw ProviderError.coded("accessibility_error", "AXUIElementPerformAction(\(action)) failed")
        }
        return actionMetadata(path: "accessibility", actionName: action)
    }

    private func setValue(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, Int(try requiredNumber(params, "elementIndex")))
        guard isSettable(record.element, kAXValueAttribute as String) else {
            throw ProviderError.coded("value_not_settable", "element \(record.index) is not settable")
        }
        let result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, try requiredStringAllowingEmpty(params, "value") as CFString)
        guard result == .success else {
            throw ProviderError.coded("accessibility_error", "AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
        return actionMetadata(path: "accessibility", actionName: "AXSetValue")
    }

    private func typeText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        try Input.typeText(try requiredString(params, "text"), pid: snapshot.app.pid)
        return actionMetadata(path: "synthetic")
    }

    private func pressKey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        try Input.pressKey(try requiredString(params, "key"), pid: snapshot.app.pid)
        return actionMetadata(path: "synthetic")
    }

    private func hotkey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let key = try requiredString(params, "key")
        if isSelectAllHotkey(key), let focused = focusedRecord(snapshot), TextInput.selectAll(focused.element) {
            return actionMetadata(
                path: "accessibility",
                actionName: "AXSelectAll",
                verification: TextInput.selectionVerification(focused.element)
            )
        }
        try Input.pressKey(key, pid: snapshot.app.pid)
        return actionMetadata(
            path: "synthetic",
            actionName: "hotkey",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func pasteText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let text = try requiredString(params, "text")
        if let focused = focusedRecord(snapshot), let verification = TextInput.replaceSelection(focused.element, with: text) {
            return actionMetadata(path: "accessibility", actionName: "AXReplaceSelection", verification: verification)
        }
        try Input.pasteText(text, pid: snapshot.app.pid)
        return actionMetadata(
            path: "clipboard",
            actionName: "paste",
            verification: unverifiedAction(reason: "clipboard_paste")
        )
    }

    private func scroll(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let direction = try requiredString(params, "direction")
        let pages = params["pages"]?.number ?? 1
        if let elementIndex = params["elementIndex"]?.number {
            let record = try element(snapshot, Int(elementIndex))
            let action = "AXScroll\(direction.capitalized)ByPage"
            if pages.rounded() == pages, record.actions.contains(action) {
                for _ in 0..<max(1, Int(pages)) {
                    _ = performAction(record.element, action)
                }
                return actionMetadata(path: "accessibility", actionName: action)
            }
            guard let point = center(record.localFrame, in: snapshot.windowBounds) else {
                throw ProviderError.coded("element_not_found", "element \(record.index) has no scrollable frame")
            }
            try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
            return actionMetadata(path: "synthetic", fallbackReason: "actionUnsupported")
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
        return actionMetadata(path: "synthetic")
    }

    private func drag(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let start: CGPoint
        let end: CGPoint
        if let fromIndex = params["fromElementIndex"]?.number, let toIndex = params["toElementIndex"]?.number {
            let from = try element(snapshot, Int(fromIndex))
            let to = try element(snapshot, Int(toIndex))
            guard let fromPoint = center(from.localFrame, in: snapshot.windowBounds),
                  let toPoint = center(to.localFrame, in: snapshot.windowBounds)
            else {
                throw ProviderError.coded("element_not_found", "drag element has no frame")
            }
            start = fromPoint
            end = toPoint
        } else {
            start = try coordinatePoint(params: params, xKey: "fromX", yKey: "fromY", snapshot: snapshot)
            end = try coordinatePoint(params: params, xKey: "toX", yKey: "toY", snapshot: snapshot)
        }
        try Input.drag(pid: snapshot.app.pid, from: start, to: end)
        return actionMetadata(path: "synthetic")
    }

    private func element(_ snapshot: Snapshot, _ index: Int) throws -> ElementRecord {
        guard let record = snapshot.elements[index] else {
            throw ProviderError.coded("element_not_found", "element \(index) is not in the current cached snapshot for \(snapshot.app.name); run get-app-state again and use a fresh element index")
        }
        return record
    }

    private func focusedRecord(_ snapshot: Snapshot) -> ElementRecord? {
        guard let focusedElementId = snapshot.focusedElementId else {
            return nil
        }
        return snapshot.elements[focusedElementId]
    }
}

private let blockedBundleIds: Set<String> = [
    "com.1password.1password",
    "com.1password.safari",
    "com.bitwarden.desktop",
    "com.dashlane.dashlanephonefinal",
    "com.lastpass.LastPass",
    "com.nordsec.nordpass",
    "me.proton.pass.electron",
    "me.proton.pass.catalyst",
]

private func requiredString(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string, !value.isEmpty else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func requiredStringAllowingEmpty(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func requiredNumber(_ params: [String: JSONValue], _ key: String) throws -> Double {
    guard let value = params[key]?.number, value.isFinite else {
        throw ProviderError.coded("invalid_argument", "missing \(key)")
    }
    return value
}

private func parsePid(_ query: String) -> pid_t? {
    guard query.hasPrefix("pid:") else { return nil }
    guard let pid = Int32(query.dropFirst(4)), pid > 0 else { return nil }
    return pid
}

private func matches(_ app: AppDescriptor, query: String) -> Bool {
    app.name.caseInsensitiveCompare(query) == .orderedSame ||
        app.bundleId?.caseInsensitiveCompare(query) == .orderedSame
}

private func pidIsLive(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0
}

private func accessibilityTrusted() -> Bool {
    AXIsProcessTrusted()
}

private func promptForAccessibility() -> Bool {
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

private func screenCaptureTrusted() -> Bool {
    CGPreflightScreenCaptureAccess()
}

private func requestScreenCaptureAccess() -> Bool {
    CGRequestScreenCaptureAccess()
}

private func openAccessibilitySettings() {
    openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
}

private func openScreenRecordingSettings() {
    openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
}

private func openSystemSettings(_ value: String) {
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
}

private func enableManualAccessibilityIfNeeded(_ appElement: AXUIElement, app: AppDescriptor) {
    guard app.needsManualAccessibilityMode else {
        return
    }
    _ = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

private func focusedWindow(appElement: AXUIElement, app: AppDescriptor, visibleWindowCount: Int, allowRecovery: Bool) throws -> AXUIElement {
    let systemWide = AXUIElementCreateSystemWide()
    if let window = focusedSystemWindow(systemWide: systemWide, app: app) {
        return window
    }
    if let window = copyElement(appElement, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let windows = copyArray(appElement, kAXWindowsAttribute as String) {
        if let window = windows.first(where: usableWindow) {
            return window
        }
    }
    if allowRecovery {
        recoverWindow(app)
        if let window = focusedSystemWindow(systemWide: systemWide, app: app) {
            return window
        }
        if let window = copyElement(appElement, kAXFocusedWindowAttribute as String), usableWindow(window) {
            return window
        }
        if let windows = copyArray(appElement, kAXWindowsAttribute as String) {
            if let window = windows.first(where: usableWindow) {
                return window
            }
        }
    }
    let permissionHint = visibleWindowCount > 0
        ? " The app has visible windows, so macOS Accessibility may need Orca Computer Use toggled off and on again in System Settings."
        : ""
    throw ProviderError.coded("window_not_found", "app '\(app.name)' has no accessibility window; make sure the app has a visible window, then retry with --restore-window.\(permissionHint)")
}

private func focusedSystemWindow(systemWide: AXUIElement, app: AppDescriptor) -> AXUIElement? {
    guard let focusedApp = copyElement(systemWide, kAXFocusedApplicationAttribute as String),
          pidAttribute(focusedApp) == app.pid
    else {
        return nil
    }
    if let window = copyElement(systemWide, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let window = copyElement(focusedApp, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let windows = copyArray(focusedApp, kAXWindowsAttribute as String) {
        return windows.first(where: usableWindow)
    }
    return nil
}

private func isTargetWindowFocused(_ snapshot: Snapshot) -> Bool {
    guard let focusedWindow = focusedSystemWindow(systemWide: AXUIElementCreateSystemWide(), app: snapshot.app) else {
        return false
    }
    if windowNumber(focusedWindow) == snapshot.windowId {
        return true
    }
    guard let frame = absoluteFrame(focusedWindow) else {
        return false
    }
    let intersection = frame.intersection(snapshot.windowBounds)
    return !intersection.isNull && intersection.area >= min(frame.area, snapshot.windowBounds.area) * 0.75
}

private func matchingWindow(appElement: AXUIElement, capture: WindowCapture, focused: AXUIElement, explicitTarget: Bool) -> AXUIElement? {
    guard let windows = copyArray(appElement, kAXWindowsAttribute as String) else {
        return nil
    }
    if let byNumber = windows.first(where: { windowNumber($0) == capture.windowId }) {
        return byNumber
    }
    if let byBounds = windows.first(where: { window in
        guard usableWindow(window), let frame = absoluteFrame(window) else { return false }
        let intersection = frame.intersection(capture.bounds)
        return !intersection.isNull && intersection.area >= min(frame.area, capture.bounds.area) * 0.75
    }) {
        return byBounds
    }
    if explicitTarget {
        return nil
    }
    guard let titleHint = capture.title, !titleHint.isEmpty else {
        return focused
    }
    return windows.first {
        usableWindow($0) && stringAttribute($0, kAXTitleAttribute as String) == titleHint
    } ?? focused
}

private func recoverWindow(_ app: AppDescriptor) {
    _ = app.app.unhide()
    _ = app.app.activate(options: [.activateAllWindows])
    if let bundleId = app.bundleId {
        openBundle(bundleId)
    }
    let appElement = AXUIElementCreateApplication(app.pid)
    if let window = copyElement(appElement, kAXFocusedWindowAttribute as String) ?? copyArray(appElement, kAXWindowsAttribute as String)?.first {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    Thread.sleep(forTimeInterval: 0.4)
}

private func openBundle(_ bundleId: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-b", bundleId]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try? process.run()
    process.waitUntilExit()
}

private func requestedWindowId(_ params: [String: JSONValue]) -> CGWindowID? {
    guard let value = params["windowId"]?.number, value >= 0 else { return nil }
    return CGWindowID(UInt32(value))
}

private func snapshotWindowKey(_ query: String, _ windowId: CGWindowID) -> String {
    "\(query.lowercased())#window:\(Int(windowId))"
}

private func snapshotWindowIndexKey(_ query: String, _ windowIndex: Int) -> String {
    "\(query.lowercased())#windowIndex:\(windowIndex)"
}

private func snapshotNamespace(_ params: [String: JSONValue]) -> String {
    if let session = params["session"]?.string, !session.isEmpty {
        return "session:\(session)"
    }
    if let worktree = params["worktree"]?.string, !worktree.isEmpty {
        return "worktree:\(worktree)"
    }
    return "default"
}

private func namespacedSnapshotKey(_ namespace: String, _ key: String) -> String {
    "\(namespace):\(key.lowercased())"
}

private func isExplicitSnapshotNamespace(_ namespace: String) -> Bool {
    namespace != "default"
}

private func requestedWindowIndex(_ params: [String: JSONValue]) -> Int? {
    guard let value = params["windowIndex"]?.number, value >= 0 else { return nil }
    return Int(value)
}

private func usableWindow(_ element: AXUIElement) -> Bool {
    stringAttribute(element, kAXRoleAttribute as String) == kAXWindowRole as String &&
        boolAttribute(element, kAXMinimizedAttribute as String) != true
}

private func focusedElement(appElement: AXUIElement) -> AXUIElement? {
    copyElement(appElement, kAXFocusedUIElementAttribute as String)
}

private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return (value as! AXUIElement)
}

private func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return value as? [AXUIElement]
}

private func pidAttribute(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else {
        return nil
    }
    return pid
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
        return url.absoluteString
    }
    return nil
}

private func rawStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
          let value,
          CFGetTypeID(value) == CFStringGetTypeID()
    else {
        return nil
    }
    return value as? String
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? Bool
}

private func numberAttribute(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? NSNumber
}

private func windowNumber(_ element: AXUIElement) -> CGWindowID? {
    guard let number = numberAttribute(element, "AXWindowNumber") else {
        return nil
    }
    return CGWindowID(number.uint32Value)
}

private func absoluteFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: point, size: size)
}

private extension CGRect {
    var area: CGFloat {
        max(width, 0) * max(height, 0)
    }
}

private func actions(_ element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success, let value else {
        return []
    }
    return value as? [String] ?? []
}

private func performAction(_ element: AXUIElement, _ action: String) -> Bool {
    actions(element).contains(where: { $0.caseInsensitiveCompare(action) == .orderedSame }) &&
        AXUIElementPerformAction(element, action as CFString) == .success
}

private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
}

private func frame(_ element: AXUIElement, windowBounds: CGRect) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(x: point.x - windowBounds.minX, y: point.y - windowBounds.minY, width: size.width, height: size.height)
}

private func elementSignature(_ node: SnapshotRenderNode) -> String {
    [
        node.role,
        node.roleDescription ?? "",
        node.title ?? "",
        node.label ?? "",
        node.linkText ?? "",
        node.value ?? "",
        node.placeholder ?? "",
        node.url ?? "",
        node.summary ?? "",
        node.rowSummary ?? "",
        SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role).joined(separator: ","),
    ].joined(separator: "\u{1f}")
}

private func center(_ localFrame: CGRect?, in windowBounds: CGRect) -> CGPoint? {
    guard let localFrame else { return nil }
    return CGPoint(x: windowBounds.minX + localFrame.midX, y: windowBounds.minY + localFrame.midY)
}

private func screenIndex(for bounds: CGRect) -> Int? {
    guard let index = NSScreen.screens.firstIndex(where: { $0.frame.intersects(bounds) }) else {
        return nil
    }
    return index
}

private func coordinatePoint(params: [String: JSONValue], xKey: String, yKey: String, snapshot: Snapshot) throws -> CGPoint {
    let x = try requiredNumber(params, xKey)
    let y = try requiredNumber(params, yKey)
    return CGPoint(
        x: snapshot.windowBounds.minX + x,
        y: snapshot.windowBounds.minY + y
    )
}

private func screenshotScale(screenshot: ScreenshotPayload?, bounds: CGRect) -> CGSize {
    guard let screenshot, bounds.width > 0, bounds.height > 0 else {
        return CGSize(width: 1, height: 1)
    }
    return CGSize(
        width: CGFloat(screenshot.width) / bounds.width,
        height: CGFloat(screenshot.height) / bounds.height
    )
}

private enum MouseButton {
    case left
    case right

    var cgButton: CGMouseButton {
        switch self {
        case .left:
            return .left
        case .right:
            return .right
        }
    }

    var downEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseDown
        case .right:
            return .rightMouseDown
        }
    }

    var upEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseUp
        case .right:
            return .rightMouseUp
        }
    }
}

private func mouseButton(_ raw: String?) throws -> MouseButton {
    switch raw ?? "left" {
    case "left":
        return .left
    case "right":
        return .right
    case "middle":
        throw ProviderError.coded("invalid_argument", "middle-click is not yet supported")
    case let value:
        throw ProviderError.coded("invalid_argument", "unsupported mouse button '\(value)'")
    }
}

private func renderTreeText(app: AppDescriptor, title: String, bounds: CGRect, lines: [String], focused: String?) -> String {
    var output = [
        "App=\(app.bundleId ?? app.name.replacingOccurrences(of: " ", with: "_")) (pid \(app.pid))",
        "Window: \"\(sanitize(title))\", App: \(sanitize(app.name)).",
        "",
    ]
    output.append(contentsOf: lines)
    output.append("")
    output.append(focused.map { "The focused UI element is \($0)." } ?? "No UI element is currently focused.")
    return output.joined(separator: "\n")
}

private func renderScreenshotStatus(_ status: ScreenshotStatus, snapshot: Snapshot) -> [String: Any] {
    let metadata: [String: Any] = [
        "engine": snapshot.screenshotEngine ?? "unknown",
        "windowId": Int(snapshot.windowId),
    ]
    switch status {
    case .captured:
        return ["state": "captured", "metadata": metadata]
    case .skipped:
        return ["state": "skipped", "reason": "no_screenshot_flag"]
    case let .failed(message):
        return ["state": "failed", "code": "screenshot_failed", "message": message, "metadata": metadata]
    }
}

private final class TreeRenderer {
    let windowBounds: CGRect
    let focused: AXUIElement?
    var lines: [String] = []
    var records: [Int: ElementRecord] = [:]
    var focusedSummary: String?
    var focusedElementId: Int?
    var truncated = false
    var maxDepthReached = false
    private var nextIndex = 0
    static let maxNodes = 1200
    static let maxDepth = 64

    init(windowBounds: CGRect, focused: AXUIElement?) {
        self.windowBounds = windowBounds
        self.focused = focused
    }

    func render(_ element: AXUIElement, depth: Int = 0, ancestors: [AXUIElement] = []) {
        guard nextIndex < Self.maxNodes else {
            truncated = true
            return
        }
        guard depth < Self.maxDepth else {
            truncated = true
            maxDepthReached = true
            return
        }
        guard !ancestors.contains(where: { CFEqual($0, element) }) else { return }

        let role = stringAttribute(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let children = primaryChildren(element, role: role, windowBounds: windowBounds)
        let value = valueString(element)
        let placeholder = placeholderString(element)
        let rawActions = actions(element)
        let rowSummary = rowTextSummary(element, role: role)
        let linkText = role == "AXLink" ? descendantTextSnippets(element, limit: 2, maxDepth: 3).first : nil
        let baseNode = SnapshotRenderNode(
            role: role,
            roleDescription: stringAttribute(element, kAXRoleDescriptionAttribute as String),
            title: stringAttribute(element, kAXTitleAttribute as String),
            label: stringAttribute(element, kAXDescriptionAttribute as String),
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: stringAttribute(element, kAXURLAttribute as String),
            traits: [],
            rawActions: rawActions,
            childCount: children.count,
            rowSummary: rowSummary
        )
        let name = SnapshotRenderHeuristics.displayName(baseNode)
        let meaningful = SnapshotRenderHeuristics.meaningfulActions(rawActions, role: role)
        let localFrame = frame(element, windowBounds: windowBounds)
        let traits = traitsFor(element, role: role)
        let webAreaDepth = webAreaDepth(role: role, ancestors: ancestors)
        let summary = genericTextSummary(element, role: role, name: name, actions: meaningful, traits: traits)
        let node = SnapshotRenderNode(
            role: role,
            roleDescription: stringAttribute(element, kAXRoleDescriptionAttribute as String),
            title: stringAttribute(element, kAXTitleAttribute as String),
            label: stringAttribute(element, kAXDescriptionAttribute as String),
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: stringAttribute(element, kAXURLAttribute as String),
            traits: traits,
            rawActions: rawActions,
            childCount: children.count,
            summary: summary,
            rowSummary: rowSummary,
            webAreaDepth: webAreaDepth
        )
        if SnapshotRenderHeuristics.shouldElide(node) {
            for child in children {
                render(child, depth: depth, ancestors: ancestors + [element])
            }
            return
        }

        let index = nextIndex
        nextIndex += 1
        let line = SnapshotRenderHeuristics.line(index: index, node: node)
        lines.append(String(repeating: "\t", count: depth) + line)
        records[index] = ElementRecord(
            index: index,
            element: element,
            localFrame: localFrame,
            actions: rawActions,
            signature: elementSignature(node)
        )
        if let focused, CFEqual(focused, element) {
            focusedElementId = index
            focusedSummary = line
        }
        if summary != nil || SnapshotRenderHeuristics.shouldSuppressChildren(node) {
            return
        }
        for child in children {
            render(child, depth: depth + 1, ancestors: ancestors + [element])
        }
    }
}

private func valueString(_ element: AXUIElement) -> String? {
    if isSecureTextElement(element) {
        return "[redacted]"
    }
    if let string = stringAttribute(element, kAXValueAttribute as String) {
        return string
    }
    if let number = numberAttribute(element, kAXValueAttribute as String) {
        return number.stringValue
    }
    return nil
}

private func isSecureTextElement(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, kAXRoleAttribute as String)?.lowercased() ?? ""
    let subrole = stringAttribute(element, kAXSubroleAttribute as String)?.lowercased() ?? ""
    let title = stringAttribute(element, kAXTitleAttribute as String)?.lowercased() ?? ""
    let description = stringAttribute(element, kAXDescriptionAttribute as String)?.lowercased() ?? ""
    let placeholder = placeholderString(element)?.lowercased() ?? ""
    let haystack = [role, subrole, title, description, placeholder].joined(separator: " ")
    return haystack.contains("secure") ||
        haystack.contains("password") ||
        haystack.contains("passcode") ||
        haystack.contains("verification code") ||
        haystack.contains("one-time code")
}

private func placeholderString(_ element: AXUIElement) -> String? {
    stringAttribute(element, "AXPlaceholderValue") ?? stringAttribute(element, "AXPlaceholder")
}

private func traitsFor(_ element: AXUIElement, role: String) -> [String] {
    var traits: [String] = []
    if boolAttribute(element, kAXSelectedAttribute as String) == true { traits.append("selected") }
    if boolAttribute(element, kAXExpandedAttribute as String) == true { traits.append("expanded") }
    if boolAttribute(element, kAXEnabledAttribute as String) == false { traits.append("disabled") }
    if valueSettableRoles.contains(role), isSettable(element, kAXValueAttribute as String) { traits.append("settable") }
    return traits
}

private let valueSettableRoles: Set<String> = [
    kAXCheckBoxRole as String,
    kAXComboBoxRole as String,
    kAXRadioButtonRole as String,
    "AXSearchField",
    kAXSliderRole as String,
    kAXTextAreaRole as String,
    kAXTextFieldRole as String,
]

private func primaryChildren(_ element: AXUIElement, role: String, windowBounds: CGRect) -> [AXUIElement] {
    if usesRowsAsPrimaryChildren(role: role), let rows = copyArray(element, kAXRowsAttribute as String), !rows.isEmpty {
        return visibleRows(rows, parent: element, windowBounds: windowBounds)
    }
    return copyArray(element, kAXChildrenAttribute as String) ?? []
}

private func visibleRows(_ rows: [AXUIElement], parent: AXUIElement, windowBounds: CGRect) -> [AXUIElement] {
    guard let parentFrame = frame(parent, windowBounds: windowBounds) else {
        return Array(rows.prefix(20))
    }
    let visible = rows.filter { row in
        guard let rowFrame = frame(row, windowBounds: windowBounds) else { return false }
        return rowFrame.intersects(parentFrame)
    }
    return Array((visible.isEmpty ? rows : visible).prefix(20))
}

private func usesRowsAsPrimaryChildren(role: String) -> Bool {
    [
        kAXBrowserRole as String,
        kAXListRole as String,
        kAXOutlineRole as String,
        kAXTableRole as String,
    ].contains(role)
}

private func genericTextSummary(
    _ element: AXUIElement,
    role: String,
    name: String?,
    actions: [String],
    traits: [String]
) -> String? {
    guard (role == kAXGroupRole as String || role == kAXUnknownRole as String),
          name == nil,
          actions.isEmpty,
          traits.isEmpty,
          isPlainTextSubtree(element, maxDepth: 4)
    else {
        return nil
    }
    let texts = descendantTextSnippets(element, limit: 8, maxDepth: 4)
    guard texts.count >= 2 else { return nil }
    let summary = texts.joined(separator: " ")
    guard summary.count <= 220 else { return nil }
    return summary
}

private func rowTextSummary(_ element: AXUIElement, role: String) -> String? {
    guard ["AXRow", "AXCell", "AXOutlineRow"].contains(role) else { return nil }
    let texts = descendantTextSnippets(element, limit: 6, maxDepth: 3)
    guard !texts.isEmpty else { return nil }
    return texts.joined(separator: " ")
}

private func isPlainTextSubtree(_ element: AXUIElement, maxDepth: Int) -> Bool {
    var sawText = false
    let allowedContainerRoles: Set<String> = [
        kAXGroupRole as String,
        kAXUnknownRole as String,
        kAXStaticTextRole as String,
        "AXLink",
        "AXImage",
    ]

    func visit(_ node: AXUIElement, depth: Int) -> Bool {
        guard depth <= maxDepth else { return false }
        let role = stringAttribute(node, kAXRoleAttribute as String) ?? "AXUnknown"
        guard allowedContainerRoles.contains(role) else { return false }
        if role == kAXStaticTextRole as String || role == "AXLink" {
            sawText = true
        }
        guard SnapshotRenderHeuristics.meaningfulActions(actions(node), role: role).isEmpty else { return false }
        for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
            guard visit(child, depth: depth + 1) else { return false }
        }
        return true
    }

    return visit(element, depth: 0) && sawText
}

private func descendantTextSnippets(_ element: AXUIElement, limit: Int, maxDepth: Int) -> [String] {
    var values: [String] = []
    var seen = Set<String>()

    func collect(_ node: AXUIElement, depth: Int) {
        guard values.count < limit, depth <= maxDepth else { return }
        let role = stringAttribute(node, kAXRoleAttribute as String) ?? ""
        if role == kAXStaticTextRole as String || role == "AXLink" {
            for candidate in [
                stringAttribute(node, kAXValueAttribute as String),
                stringAttribute(node, kAXTitleAttribute as String),
                stringAttribute(node, kAXDescriptionAttribute as String),
            ] {
                guard let candidate else { continue }
                let text = preview(candidate, maxLength: 80)
                guard !text.isEmpty, seen.insert(text).inserted else { continue }
                values.append(text)
                if values.count >= limit { return }
            }
        }
        for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
            collect(child, depth: depth + 1)
            if values.count >= limit { return }
        }
    }

    collect(element, depth: 0)
    return values
}

private func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
    if role == "AXWebArea" { return 0 }
    guard let index = ancestors.firstIndex(where: { stringAttribute($0, kAXRoleAttribute as String) == "AXWebArea" }) else {
        return nil
    }
    return ancestors.count - index
}

private func sanitize(_ value: String) -> String {
    value.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
}

private func preview(_ value: String, maxLength: Int = 120) -> String {
    let clean = sanitize(value)
    if clean.count <= maxLength {
        return clean
    }
    return String(clean.prefix(maxLength)) + "..."
}

private func actionMetadata(
    path: String,
    actionName: String? = nil,
    fallbackReason: String? = nil,
    verification: [String: Any]? = nil
) -> [String: Any] {
    var metadata: [String: Any] = [
        "path": path,
        "actionName": jsonNullable(actionName),
        "fallbackReason": jsonNullable(fallbackReason),
    ]
    if let verification {
        metadata["verification"] = verification
    }
    return metadata
}

private func verifiedAction(property: String, expected: String? = nil, actualPreview: String? = nil) -> [String: Any] {
    [
        "state": "verified",
        "property": property,
        "expected": jsonNullable(expected),
        "actualPreview": jsonNullable(actualPreview),
    ]
}

private func unverifiedAction(reason: String) -> [String: Any] {
    [
        "state": "unverified",
        "reason": reason,
    ]
}

private func jsonNullable<T>(_ value: T?) -> Any {
    value ?? NSNull()
}

private struct WindowCandidate {
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let alpha: CGFloat
    let isOnScreen: Bool
    let sharingState: Int?

    var score: Int {
        var value = Int(bounds.width * bounds.height)
        if layer == 0 { value += 1_000_000_000 }
        if title != nil && title?.isEmpty == false { value += 10_000_000 }
        if isOnScreen { value += 1_000_000 }
        if alpha >= 0.99 { value += 100_000 }
        return value
    }
}

private struct WindowCapture {
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let image: CapturedImage?

    static func resolve(pid: pid_t, titleHint: String?, windowId: CGWindowID?, windowIndex: Int?) -> WindowCapture? {
        resolve(candidates: candidates(pid: pid), titleHint: titleHint, windowId: windowId, windowIndex: windowIndex)
    }

    static func resolve(candidates: [WindowCandidate], titleHint: String?, windowId: CGWindowID?, windowIndex: Int?) -> WindowCapture? {
        if let windowId {
            guard let candidate = candidates.first(where: { $0.windowId == windowId }) else { return nil }
            return WindowCapture(candidate: candidate)
        }
        if let windowIndex {
            let visibleWindows = candidates.filter { $0.layer == 0 }
            guard visibleWindows.indices.contains(windowIndex) else { return nil }
            return WindowCapture(candidate: visibleWindows[windowIndex])
        }
        guard let best = candidates.sorted(by: { lhs, rhs in
            if let titleHint, lhs.title == titleHint, rhs.title != titleHint { return true }
            if let titleHint, rhs.title == titleHint, lhs.title != titleHint { return false }
            return lhs.score > rhs.score
        }).first else {
            return nil
        }
        return WindowCapture(candidate: best)
    }

    private init(candidate: WindowCandidate) {
        self.windowId = candidate.windowId
        self.layer = candidate.layer
        self.bounds = candidate.bounds
        self.title = candidate.title
        self.image = Self.captureImage(windowId: candidate.windowId, bounds: candidate.bounds)
    }

    static func candidates(pid: pid_t) -> [WindowCandidate] {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return infos.compactMap { info in
            guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid,
                  let number = info[kCGWindowNumber as String] as? NSNumber,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width >= 48,
                  bounds.height >= 48
            else {
                return nil
            }
            let alpha = info[kCGWindowAlpha as String] as? CGFloat ?? 1
            guard alpha > 0.01 else { return nil }
            let sharing = (info[kCGWindowSharingState as String] as? NSNumber).map { $0.intValue }
            if sharing == 0 { return nil }
            let isOnScreen = (info[kCGWindowIsOnscreen as String] as? Bool) ?? true
            return WindowCandidate(
                windowId: CGWindowID(number.uint32Value),
                layer: layer,
                bounds: bounds,
                title: info[kCGWindowName as String] as? String,
                alpha: alpha,
                isOnScreen: isOnScreen,
                sharingState: sharing
            )
        }
        .sorted { lhs, rhs in
            lhs.score > rhs.score
        }
    }

    func screenshotPayload() -> ScreenshotPayload? {
        guard let image, let bounded = boundedPngData(image.image) else { return nil }
        return ScreenshotPayload(
            data: bounded.data.base64EncodedString(),
            width: bounded.width,
            height: bounded.height,
            scale: Double(bounded.width) / max(Double(bounds.width), 1)
        )
    }

    private static func captureImage(windowId: CGWindowID, bounds: CGRect) -> CapturedImage? {
        if ProcessInfo.processInfo.environment["ORCA_COMPUTER_USE_SCK_SCREENSHOTS"] == "1",
           let image = captureImageWithScreenCaptureKit(windowId: windowId, bounds: bounds) {
            return CapturedImage(image: image, engine: "screenCaptureKit")
        }
        if let image = CGWindowListCreateImage(.null, [.optionIncludingWindow], windowId, [.boundsIgnoreFraming, .bestResolution]) {
            return CapturedImage(image: image, engine: "cgWindowList")
        }
        return nil
    }

    private static func captureImageWithScreenCaptureKit(windowId: CGWindowID, bounds: CGRect) -> CGImage? {
        try? BlockingAsync.run(timeout: 3) {
            let content = try await SCShareableContent.current
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                return nil
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            let scale = NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
            configuration.width = size_t(max(1, Int((bounds.width * scale).rounded(.up))))
            configuration.height = size_t(max(1, Int((bounds.height * scale).rounded(.up))))
            configuration.scalesToFit = true
            configuration.preservesAspectRatio = true
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.ignoreGlobalClipSingleWindow = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        }
    }
}

private final class AsyncBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

private enum BlockingAsync {
    static func run<T>(timeout: TimeInterval, operation: @escaping @Sendable () async throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<T>()
        let task = Task.detached {
            do {
                box.result = .success(try await operation())
            } catch {
                box.result = .failure(error)
            }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            task.cancel()
            throw ProviderError.coded("action_timeout", "screenshot capture timed out")
        }
        return try box.result!.get()
    }
}

private struct BoundedPNG {
    let data: Data
    let width: Int
    let height: Int
}

private func boundedPngData(_ image: CGImage) -> BoundedPNG? {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
    if data.count <= 900_000 {
        return BoundedPNG(data: data, width: image.width, height: image.height)
    }
    var scale = min(1, 1280 / CGFloat(max(image.width, image.height)))
    var best = BoundedPNG(data: data, width: image.width, height: image.height)
    while scale >= 0.25 {
        guard let resized = resizePng(image, scale: scale) else {
            break
        }
        best = resized
        if resized.data.count <= 900_000 {
            return resized
        }
        scale *= 0.85
    }
    return best
}

private func resizePng(_ image: CGImage, scale: CGFloat) -> BoundedPNG? {
    let width = max(1, Int(CGFloat(image.width) * scale))
    let height = max(1, Int(CGFloat(image.height) * scale))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        return nil
    }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let resized = context.makeImage() else { return nil }
    guard let data = NSBitmapImageRep(cgImage: resized).representation(using: .png, properties: [:]) else {
        return nil
    }
    return BoundedPNG(data: data, width: width, height: height)
}

private enum Input {
    static func click(pid: pid_t, at point: CGPoint, button: MouseButton, count: Int) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        for _ in 0..<max(count, 1) {
            try mouse(.mouseMoved, source: source, point: point, button: button.cgButton, pid: pid)
            try mouse(button.downEvent, source: source, point: point, button: button.cgButton, pid: pid)
            try mouse(button.upEvent, source: source, point: point, button: button.cgButton, pid: pid)
        }
    }

    static func scroll(pid: pid_t, at point: CGPoint, direction: String, pages: Double) throws {
        let delta = Int32(max(1, (12 * pages).rounded()))
        let wheel1: Int32 = direction == "up" ? delta : direction == "down" ? -delta : 0
        let wheel2: Int32 = direction == "left" ? delta : direction == "right" ? -delta : 0
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
            throw ProviderError.coded("accessibility_error", "failed to create scroll event")
        }
        event.location = point
        event.postToPid(pid)
    }

    static func drag(pid: pid_t, from start: CGPoint, to end: CGPoint) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        try mouse(.mouseMoved, source: source, point: start, button: .left, pid: pid)
        try mouse(.leftMouseDown, source: source, point: start, button: .left, pid: pid)
        for step in 1...10 {
            let progress = CGFloat(step) / 10
            try mouse(
                .leftMouseDragged,
                source: source,
                point: CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress),
                button: .left,
                pid: pid
            )
        }
        try mouse(.leftMouseUp, source: source, point: end, button: .left, pid: pid)
    }

    static func typeText(_ text: String, pid: pid_t) throws {
        for unit in text.utf16 {
            var char = unit
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else {
                throw ProviderError.coded("accessibility_error", "failed to create keyboard event")
            }
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    static func pressKey(_ key: String, pid: pid_t) throws {
        let parsed = try KeyMap.parse(key)
        var flags = CGEventFlags()
        for modifier in parsed.modifiers {
            flags.insert(modifier.flag)
            try keyEvent(modifier.keyCode, down: true, flags: flags, pid: pid)
        }
        try keyEvent(parsed.keyCode, down: true, flags: flags, pid: pid)
        try keyEvent(parsed.keyCode, down: false, flags: flags, pid: pid)
        for modifier in parsed.modifiers.reversed() {
            try keyEvent(modifier.keyCode, down: false, flags: flags, pid: pid)
            flags.remove(modifier.flag)
        }
    }

    static func pasteText(_ text: String, pid: pid_t) throws {
        let pasteboard = NSPasteboard.general
        let previousItems: [NSPasteboardItem] = pasteboard.pasteboardItems?.map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        } ?? []
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        defer {
            pasteboard.clearContents()
            if !previousItems.isEmpty {
                pasteboard.writeObjects(previousItems)
            }
        }
        try pressKey("cmd+v", pid: pid)
    }

    private static func mouse(_ type: CGEventType, source: CGEventSource, point: CGPoint, button: CGMouseButton, pid: pid_t) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ProviderError.coded("accessibility_error", "failed to create mouse event")
        }
        event.postToPid(pid)
    }

    private static func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags, pid: pid_t) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else {
            throw ProviderError.coded("accessibility_error", "failed to create key event")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
}

private enum TextInput {
    static func replaceSelection(_ element: AXUIElement, with text: String) -> [String: Any]? {
        guard isSettable(element, kAXValueAttribute as String),
              let current = rawStringAttribute(element, kAXValueAttribute as String)
        else {
            return nil
        }
        let selectedRange = selectedTextRange(element) ?? CFRange(location: current.utf16.count, length: 0)
        let startOffset = max(0, min(selectedRange.location, current.utf16.count))
        let endOffset = max(startOffset, min(startOffset + selectedRange.length, current.utf16.count))
        let start = String.Index(utf16Offset: startOffset, in: current)
        let end = String.Index(utf16Offset: endOffset, in: current)
        let next = String(current[..<start]) + text + String(current[end...])
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, next as CFString) == .success else {
            return nil
        }
        setSelectedTextRange(element, CFRange(location: startOffset + text.utf16.count, length: 0))
        guard rawStringAttribute(element, kAXValueAttribute as String) == next else {
            return nil
        }
        return verifiedAction(
            property: "focusedText",
            expected: text,
            actualPreview: preview(next)
        )
    }

    static func selectAll(_ element: AXUIElement) -> Bool {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String) else {
            return false
        }
        return setSelectedTextRange(element, CFRange(location: 0, length: current.utf16.count))
    }

    static func selectionVerification(_ element: AXUIElement) -> [String: Any] {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String),
              let selectedRange = selectedTextRange(element),
              selectedRange.location == 0,
              selectedRange.length == current.utf16.count
        else {
            return unverifiedAction(reason: "provider_unavailable")
        }
        return verifiedAction(property: "selection", actualPreview: preview(current))
    }

    private static func selectedTextRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID()
        else {
            return nil
        }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else {
            return nil
        }
        return range
    }

    @discardableResult
    private static func setSelectedTextRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
        var mutableRange = range
        guard let value = AXValueCreate(.cfRange, &mutableRange) else {
            return false
        }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }
}

private func isSelectAllHotkey(_ key: String) -> Bool {
    let parts = key
        .lowercased()
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: "-", with: "+")
        .split(separator: "+")
        .map(String.init)
    guard parts.last == "a" else {
        return false
    }
    let modifiers = Set(parts.dropLast())
    return modifiers.contains("cmd") ||
        modifiers.contains("command") ||
        modifiers.contains("meta") ||
        modifiers.contains("cmdorctrl") ||
        modifiers.contains("commandorcontrol")
}

private struct KeyModifier {
    let keyCode: CGKeyCode
    let flag: CGEventFlags
}

private struct ParsedKey {
    let keyCode: CGKeyCode
    let modifiers: [KeyModifier]
}

private enum KeyMap {
    static func parse(_ spec: String) throws -> ParsedKey {
        let parts = spec.split(separator: "+").map { String($0).lowercased() }
        var modifiers: [KeyModifier] = []
        var keyName: String?
        for part in parts {
            switch part {
            case "cmd", "command", "meta", "super", "cmdorctrl", "commandorcontrol":
                modifiers.append(KeyModifier(keyCode: 55, flag: .maskCommand))
            case "ctrl", "control":
                modifiers.append(KeyModifier(keyCode: 59, flag: .maskControl))
            case "alt", "option":
                modifiers.append(KeyModifier(keyCode: 58, flag: .maskAlternate))
            case "shift":
                modifiers.append(KeyModifier(keyCode: 56, flag: .maskShift))
            default:
                keyName = part
            }
        }
        guard let keyName, let keyCode = codes[keyName] else {
            throw ProviderError.coded("invalid_argument", "unsupported key '\(spec)'")
        }
        return ParsedKey(keyCode: keyCode, modifiers: modifiers)
    }

    private static let codes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "left": 123, "right": 124,
        "down": 125, "up": 126,
    ]
}

private final class AgentRuntime: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private let token: String?
    private var listener: SocketListener?

    init(socketPath: String, token: String?) {
        self.socketPath = socketPath
        self.token = token
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let listener = try SocketListener(socketPath: socketPath, token: token)
            self.listener = listener
            listener.start()
        } catch {
            fputs("failed to start computer-use socket: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        listener?.stop()
    }
}

private final class PermissionRuntime: NSObject, NSApplicationDelegate {
    private let initialPermission: PermissionKind?
    private var windowController: PermissionWindowController?

    init(initialPermission: PermissionKind?) {
        self.initialPermission = initialPermission
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        windowController = PermissionWindowController(
            terminateWhenDragAssistantCloses: initialPermission != nil
        )
        if let initialPermission {
            windowController?.openPermission(initialPermission)
        } else {
            windowController?.showWindow(nil)
            windowController?.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        initialPermission == nil
    }
}

private final class PermissionWindowController: NSWindowController {
    private var dragAssistant: PermissionDragAssistantController?
    private let terminateWhenDragAssistantCloses: Bool

    convenience init(terminateWhenDragAssistantCloses: Bool = false) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 315),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Enable Orca Computer Use"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = PermissionPalette.background
        window.center()
        window.isReleasedWhenClosed = false
        self.init(window: window, terminateWhenDragAssistantCloses: terminateWhenDragAssistantCloses)
        window.contentView = PermissionView(frame: window.contentView?.bounds ?? .zero) { [weak self] permission in
            self?.showDragAssistant(for: permission)
        }
    }

    init(window: NSWindow?, terminateWhenDragAssistantCloses: Bool) {
        self.terminateWhenDragAssistantCloses = terminateWhenDragAssistantCloses
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func showDragAssistant(for permission: PermissionKind) {
        dragAssistant?.close()
        dragAssistant = PermissionDragAssistantController(
            permission: permission,
            fallbackVisibleFrame: window?.screen?.visibleFrame,
            onClose: { [weak self] in
                if self?.terminateWhenDragAssistantCloses == true {
                    NSApp.terminate(nil)
                }
            }
        )
        dragAssistant?.showWhenReady()
    }

    func openPermission(_ permission: PermissionKind) {
        permission.requestAndOpenSettings()
        showDragAssistant(for: permission)
    }
}

private enum PermissionKind {
    case accessibility
    case screenshots

    static func parse(_ value: String?) -> PermissionKind? {
        switch value {
        case "accessibility":
            .accessibility
        case "screenshots", "screen", "screen-recording":
            .screenshots
        default:
            nil
        }
    }

    var dragInstruction: String {
        switch self {
        case .accessibility:
            "Drag Orca Computer Use into the list above to allow Accessibility."
        case .screenshots:
            "Drag Orca Computer Use into the list above to allow Screenshots."
        }
    }

    func requestAndOpenSettings() {
        switch self {
        case .accessibility:
            openAccessibilitySettings()
        case .screenshots:
            _ = requestScreenCaptureAccess()
            openScreenRecordingSettings()
        }
    }
}

private final class PermissionView: NSView {
    private let appURL = Bundle.main.bundleURL
    private let showDragAssistant: (PermissionKind) -> Void

    init(frame frameRect: NSRect, showDragAssistant: @escaping (PermissionKind) -> Void) {
        self.showDragAssistant = showDragAssistant
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = PermissionPalette.background.cgColor
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.distribution = .gravityAreas
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        let icon = NSImageView(image: NSWorkspace.shared.icon(forFile: appURL.path))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 58),
            icon.heightAnchor.constraint(equalToConstant: 58)
        ])

        let title = label("Enable Orca Computer Use", size: 22, weight: .bold)
        let subtitle = label(
            "Grant permissions so Orca can use apps when you ask.",
            size: 12,
            weight: .regular
        )
        subtitle.textColor = PermissionPalette.secondaryText
        subtitle.alignment = .center
        subtitle.maximumNumberOfLines = 3

        let header = NSStackView(views: [icon, title, subtitle])
        header.orientation = .vertical
        header.alignment = .centerX
        header.spacing = 6
        header.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -10).isActive = true

        stack.addArrangedSubview(permissionRow(
            icon: NSImage(systemSymbolName: "figure", accessibilityDescription: "Accessibility"),
            title: "Accessibility",
            detail: "Read and control app interfaces",
            buttonTitle: "Allow"
        ) {
            PermissionKind.accessibility.requestAndOpenSettings()
            self.showDragAssistant(.accessibility)
        })

        stack.addArrangedSubview(permissionRow(
            icon: NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Screen Recording"),
            title: "Screenshots",
            detail: "Capture windows for visual state",
            buttonTitle: "Allow"
        ) {
            PermissionKind.screenshots.requestAndOpenSettings()
            self.showDragAssistant(.screenshots)
        })

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 22),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -20)
        ])
    }

    private func permissionRow(
        icon: NSImage?,
        title: String,
        detail: String,
        buttonTitle: String,
        action: @escaping () -> Void
    ) -> NSView {
        let row = NSView()
        row.wantsLayer = true
        row.layer?.cornerRadius = 14
        row.layer?.borderWidth = 1
        row.layer?.borderColor = PermissionPalette.border.cgColor
        row.layer?.backgroundColor = PermissionPalette.card.cgColor
        row.translatesAutoresizingMaskIntoConstraints = false

        let iconView = NSImageView(image: icon ?? NSImage())
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 30, weight: .regular)
        iconView.contentTintColor = .controlAccentColor
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let titleLabel = label(title, size: 13, weight: .bold)
        let detailLabel = label(detail, size: 11, weight: .regular)
        detailLabel.textColor = PermissionPalette.secondaryText
        let textStack = NSStackView(views: [titleLabel, detailLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 4
        textStack.translatesAutoresizingMaskIntoConstraints = false

        let button = NSButton(title: buttonTitle, target: nil, action: nil)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        button.contentTintColor = .white
        button.bezelColor = .controlAccentColor
        let buttonTitleAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold)
        ]
        button.attributedTitle = NSAttributedString(string: buttonTitle, attributes: buttonTitleAttributes)
        button.attributedAlternateTitle = NSAttributedString(string: buttonTitle, attributes: buttonTitleAttributes)
        let target = ButtonTarget(action)
        button.target = target
        button.action = #selector(ButtonTarget.run)
        objc_setAssociatedObject(button, "orca-action", target, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        button.translatesAutoresizingMaskIntoConstraints = false

        row.addSubview(iconView)
        row.addSubview(textStack)
        row.addSubview(button)
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: 62),
            iconView.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            iconView.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 34),
            iconView.heightAnchor.constraint(equalToConstant: 34),
            textStack.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
            textStack.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 52),
            button.heightAnchor.constraint(equalToConstant: 30),
            button.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -12),
            button.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            textStack.trailingAnchor.constraint(lessThanOrEqualTo: button.leadingAnchor, constant: -12)
        ])
        return row
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.lineBreakMode = .byWordWrapping
        label.textColor = PermissionPalette.primaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }
}

private final class PermissionDragAssistantController: NSWindowController {
    private let fallbackVisibleFrame: NSRect?
    private let onClose: () -> Void
    private var hasSeenSettingsWindow = false
    private var followTimer: Timer?

    convenience init(permission: PermissionKind, fallbackVisibleFrame: NSRect?, onClose: @escaping () -> Void) {
        let window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 92),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.title = "Drag Orca Computer Use"
        window.backgroundColor = .clear
        window.isOpaque = false
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.isMovableByWindowBackground = true
        window.hasShadow = true
        self.init(window: window, fallbackVisibleFrame: fallbackVisibleFrame, onClose: onClose)
        window.contentView = PermissionDragAssistantView(permission: permission, appURL: Bundle.main.bundleURL) { [weak self, weak window] in
            window?.close()
            self?.onClose()
        }
    }

    init(window: NSWindow?, fallbackVisibleFrame: NSRect?, onClose: @escaping () -> Void) {
        self.fallbackVisibleFrame = fallbackVisibleFrame
        self.onClose = onClose
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showWhenReady() {
        startFollowingSettingsWindow()
        schedulePositionAndShow()
    }

    override func close() {
        followTimer?.invalidate()
        followTimer = nil
        super.close()
    }

    private func schedulePositionAndShow() {
        let delays = [0.12, 0.25, 0.4, 0.65, 0.95, 1.35, 1.8, 2.5]
        for (index, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.window?.isVisible != true else { return }
                if self.systemSettingsIsFrontmost() && self.positionNearSettingsWindow() {
                    self.showWindow(nil)
                    self.window?.orderFrontRegardless()
                } else if index == delays.count - 1 && self.systemSettingsIsFrontmost() {
                        self.positionFallback()
                    self.showWindow(nil)
                    self.window?.orderFrontRegardless()
                }
            }
        }
    }

    private func startFollowingSettingsWindow() {
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.syncVisibilityWithSettingsWindow()
            }
        }
    }

    private func syncVisibilityWithSettingsWindow() {
        guard let window else {
            followTimer?.invalidate()
            followTimer = nil
            return
        }
        let settingsWindowExists = systemSettingsWindowFrame() != nil
        if settingsWindowExists {
            hasSeenSettingsWindow = true
        } else if hasSeenSettingsWindow {
            NSApp.terminate(nil)
            return
        }
        if systemSettingsIsFrontmost() && settingsWindowExists && positionNearSettingsWindow() {
            if !window.isVisible {
                showWindow(nil)
            }
            window.orderFrontRegardless()
        } else if window.isVisible {
            window.orderOut(nil)
        }
    }

    private func systemSettingsIsFrontmost() -> Bool {
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        return bundleId == "com.apple.systempreferences" || bundleId == "com.apple.SystemSettings"
    }

    private func positionNearSettingsWindow() -> Bool {
        guard let window else { return false }
        guard let settingsFrame = systemSettingsWindowFrame() else { return false }
        let visibleFrame = visibleFrameContaining(settingsFrame)
        let x = settingsFrame.maxX - window.frame.width - 18
        let y = settingsFrame.minY + 18
        window.setFrameOrigin(clampedOrigin(x: x, y: y, window: window, visibleFrame: visibleFrame))
        return true
    }

    private func positionFallback() {
        guard let window else { return }
        let visibleFrame = fallbackVisibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 900, height: 700)
        let origin = NSPoint(
            x: visibleFrame.midX - window.frame.width / 2,
            y: visibleFrame.minY + 24
        )
        window.setFrameOrigin(clampedOrigin(x: origin.x, y: origin.y, window: window, visibleFrame: visibleFrame))
    }

    private func clampedOrigin(x: CGFloat, y: CGFloat, window: NSWindow, visibleFrame: NSRect) -> NSPoint {
        let inset: CGFloat = 10
        let minX = visibleFrame.minX + inset
        let maxX = visibleFrame.maxX - window.frame.width - inset
        let minY = visibleFrame.minY + inset
        let maxY = visibleFrame.maxY - window.frame.height - inset
        return NSPoint(
            x: min(max(x, minX), maxX),
            y: min(max(y, minY), maxY)
        )
    }

    private func systemSettingsWindowFrame() -> NSRect? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for windowInfo in windows {
            guard
                let ownerName = windowInfo[kCGWindowOwnerName as String] as? String,
                ownerName == "System Settings" || ownerName == "System Preferences",
                (windowInfo[kCGWindowLayer as String] as? Int) == 0,
                let bounds = windowInfo[kCGWindowBounds as String] as? [String: CGFloat],
                let x = bounds["X"],
                let y = bounds["Y"],
                let width = bounds["Width"],
                let height = bounds["Height"],
                width > 520,
                height > 360
            else {
                continue
            }
            return appKitFrameForCGWindowFrame(NSRect(x: x, y: y, width: width, height: height))
        }
        return nil
    }

    private func appKitFrameForCGWindowFrame(_ cgFrame: NSRect) -> NSRect {
        guard let screen = screenContainingCGFrame(cgFrame),
              let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else {
            return cgFrame
        }

        let displayBounds = CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value))
        return NSRect(
            x: cgFrame.minX,
            y: screen.frame.maxY - (cgFrame.minY - displayBounds.minY) - cgFrame.height,
            width: cgFrame.width,
            height: cgFrame.height
        )
    }

    private func screenContainingCGFrame(_ frame: NSRect) -> NSScreen? {
        NSScreen.screens.max { lhs, rhs in
            cgDisplayBounds(for: lhs).intersection(frame).width * cgDisplayBounds(for: lhs).intersection(frame).height <
                cgDisplayBounds(for: rhs).intersection(frame).width * cgDisplayBounds(for: rhs).intersection(frame).height
        }
    }

    private func cgDisplayBounds(for screen: NSScreen) -> NSRect {
        guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return screen.frame
        }
        return CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value))
    }

    private func visibleFrameContaining(_ frame: NSRect) -> NSRect {
        let screen = NSScreen.screens.max { lhs, rhs in
            lhs.frame.intersection(frame).width * lhs.frame.intersection(frame).height <
                rhs.frame.intersection(frame).width * rhs.frame.intersection(frame).height
        }
        return screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 900, height: 700)
    }
}

private final class PermissionDragAssistantView: NSView {
    private let permission: PermissionKind
    private let appURL: URL
    private let close: () -> Void

    init(permission: PermissionKind, appURL: URL, close: @escaping () -> Void) {
        self.permission = permission
        self.appURL = appURL
        self.close = close
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = PermissionPalette.background.cgColor
        layer?.cornerRadius = 14
        layer?.borderWidth = 1
        layer?.borderColor = PermissionPalette.border.cgColor
        layer?.masksToBounds = true
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func build() {
        let closeButton = NSButton(title: "", target: nil, action: nil)
        closeButton.bezelStyle = .shadowlessSquare
        closeButton.isBordered = false
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")
        closeButton.imagePosition = .imageOnly
        closeButton.contentTintColor = PermissionPalette.secondaryText
        closeButton.controlSize = .small
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        let target = ButtonTarget(close)
        closeButton.target = target
        closeButton.action = #selector(ButtonTarget.run)
        objc_setAssociatedObject(closeButton, "orca-action", target, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        let instruction = label(permission.dragInstruction, size: 12, weight: .semibold)
        instruction.textColor = PermissionPalette.primaryText
        instruction.maximumNumberOfLines = 2

        let dragTile = DraggableAppTile(appURL: appURL)
        dragTile.translatesAutoresizingMaskIntoConstraints = false

        addSubview(closeButton)
        addSubview(instruction)
        addSubview(dragTile)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            closeButton.widthAnchor.constraint(equalToConstant: 18),
            closeButton.heightAnchor.constraint(equalToConstant: 18),
            instruction.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 36),
            instruction.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            instruction.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            dragTile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            dragTile.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            dragTile.topAnchor.constraint(equalTo: instruction.bottomAnchor, constant: 8),
            dragTile.heightAnchor.constraint(equalToConstant: 42)
        ])
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.lineBreakMode = .byWordWrapping
        label.textColor = PermissionPalette.primaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }
}

private final class DraggableAppTile: NSView, NSDraggingSource {
    private let appURL: URL

    override var mouseDownCanMoveWindow: Bool { false }

    init(appURL: URL) {
        self.appURL = appURL
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        layer?.borderColor = PermissionPalette.border.cgColor
        layer?.backgroundColor = PermissionPalette.card.cgColor
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDragged(with event: NSEvent) {
        let item = NSPasteboardItem()
        item.setString(appURL.absoluteString, forType: .fileURL)
        item.setString(appURL.path, forType: .string)

        let draggingItem = NSDraggingItem(pasteboardWriter: item)
        let iconSize: CGFloat = 64
        let location = convert(event.locationInWindow, from: nil)
        let dragFrame = NSRect(
            x: location.x - iconSize / 2,
            y: location.y - iconSize / 2,
            width: iconSize,
            height: iconSize
        )
        draggingItem.setDraggingFrame(dragFrame, contents: appIcon(size: iconSize))
        beginDraggingSession(with: [draggingItem], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    private func build() {
        let icon = NSImageView(image: appIcon(size: 34))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "Orca Computer Use")
        title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        title.textColor = PermissionPalette.primaryText
        title.translatesAutoresizingMaskIntoConstraints = false

        addSubview(icon)
        addSubview(title)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 34),
            icon.heightAnchor.constraint(equalToConstant: 34),
            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20)
        ])
    }

    private func appIcon(size: CGFloat) -> NSImage {
        let icon = NSWorkspace.shared.icon(forFile: appURL.path)
        icon.size = NSSize(width: size, height: size)
        return icon
    }
}

private enum PermissionPalette {
    static let background = NSColor(calibratedWhite: 0.16, alpha: 0.98)
    static let card = NSColor(calibratedWhite: 0.22, alpha: 0.98)
    static let border = NSColor(calibratedWhite: 0.36, alpha: 0.9)
    static let primaryText = NSColor(calibratedWhite: 0.94, alpha: 1)
    static let secondaryText = NSColor(calibratedWhite: 0.66, alpha: 1)
}

private final class ButtonTarget: NSObject {
    private let actionBlock: () -> Void

    init(_ actionBlock: @escaping () -> Void) {
        self.actionBlock = actionBlock
    }

    @objc func run() {
        actionBlock()
    }
}

private final class SocketListener: @unchecked Sendable {
    private let socketPath: String
    private let token: String?
    private let provider = Provider()
    private let providerLock = NSLock()
    private var socketFd: Int32 = -1
    private var isStopped = false

    init(socketPath: String, token: String?) throws {
        self.socketPath = socketPath
        self.token = token
        try bindSocket()
    }

    func start() {
        Thread.detachNewThread { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        isStopped = true
        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }
        unlink(socketPath)
    }

    private func bindSocket() throws {
        unlink(socketPath)
        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            throw ProviderError.coded("accessibility_error", "failed to create computer-use socket")
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maxPathLength else {
            throw ProviderError.coded("invalid_argument", "computer-use socket path is too long")
        }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self), source, maxPathLength)
            }
        }

        let result = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(socketFd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let message = String(cString: strerror(errno))
            close(socketFd)
            socketFd = -1
            throw ProviderError.coded("accessibility_error", "failed to bind computer-use socket: \(message)")
        }
        chmod(socketPath, 0o600)

        guard listen(socketFd, 8) == 0 else {
            let message = String(cString: strerror(errno))
            close(socketFd)
            socketFd = -1
            throw ProviderError.coded("accessibility_error", "failed to listen on computer-use socket: \(message)")
        }
    }

    private func acceptLoop() {
        while !isStopped {
            let fd = accept(socketFd, nil, nil)
            if fd < 0 {
                if !isStopped {
                    fputs("computer-use socket accept failed: \(String(cString: strerror(errno)))\n", stderr)
                }
                continue
            }
            Thread.detachNewThread { [weak self] in
                self?.handleConnection(fd)
            }
        }
    }

    private func handleConnection(_ fd: Int32) {
        defer { close(fd) }
        let authorizedPeer = peerProcessId(fd).map(isAuthorizedAgentPeer) == true
        let decoder = JSONDecoder()
        while let line = readLine(from: fd) {
            guard let data = line.data(using: .utf8),
                  let request = try? decoder.decode(Request.self, from: data)
            else {
                continue
            }
            let response = handleRequest(
                provider: provider,
                lock: providerLock,
                request: request,
                expectedToken: token,
                authorizedPeer: authorizedPeer
            )
            writeJSON(response, to: fd)
        }
    }
}

private func peerProcessId(_ fd: Int32) -> pid_t? {
    var pid = pid_t(0)
    var length = socklen_t(MemoryLayout<pid_t>.size)
    let result = withUnsafeMutablePointer(to: &pid) { pointer in
        getsockopt(fd, 0, 2, pointer, &length)
    }
    return result == 0 && pid > 0 ? pid : nil
}

private func isAuthorizedAgentPeer(_ pid: pid_t) -> Bool {
    guard let command = processCommand(pid),
          command.contains("/out/main/computer-sidecar.js")
              || command.contains("/Contents/Resources/app.asar.unpacked/out/main/computer-sidecar.js")
    else {
        return false
    }
    if isTrustedOrcaApplication(pid) {
        return true
    }
    guard let parentPid = parentProcessId(pid) else { return false }
    return isTrustedOrcaApplication(parentPid)
}

private func isTrustedOrcaApplication(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid),
          let bundleId = app.bundleIdentifier
    else {
        return false
    }
    return bundleId == "com.stablyai.orca" || bundleId == "com.github.Electron"
}

private func parentProcessId(_ pid: pid_t) -> pid_t? {
    guard let output = processField(pid: pid, field: "ppid=") else {
        return nil
    }
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let parentPid = pid_t(trimmed), parentPid > 1 else {
        return nil
    }
    return parentPid
}

private func processCommand(_ pid: pid_t) -> String? {
    return processField(pid: pid, field: "command=")
}

private func processField(pid: pid_t, field: String) -> String? {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-p", "\(pid)", "-o", field]
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    } catch {
        return nil
    }
}

@MainActor
private func runAgent(socketPath: String, token: String?) {
    let app = NSApplication.shared
    let delegate = AgentRuntime(socketPath: socketPath, token: token)
    app.delegate = delegate
    // Why: SCK is reliable once this code runs as a signed app with a real TCC identity.
    setenv("ORCA_COMPUTER_USE_SCK_SCREENSHOTS", "1", 1)
    app.run()
}

@MainActor
private func runPermissionCheck(initialPermission: PermissionKind? = nil) {
    let app = NSApplication.shared
    let delegate = PermissionRuntime(initialPermission: initialPermission)
    app.delegate = delegate
    // Why: setup must foreground reliably; the long-running agent path stays accessory-only.
    app.setActivationPolicy(.regular)
    app.run()
}

private func printPermissionStatus() {
    let accessibility = accessibilityTrusted() ? "granted" : "not-granted"
    let screenshots = screenCaptureTrusted() ? "granted" : "not-granted"
    print(#"{"accessibility":"\#(accessibility)","screenshots":"\#(screenshots)"}"#)
}

private func writePermissionStatus(to path: String) {
    let accessibility = accessibilityTrusted() ? "granted" : "not-granted"
    let screenshots = screenCaptureTrusted() ? "granted" : "not-granted"
    let text = #"{"accessibility":"\#(accessibility)","screenshots":"\#(screenshots)"}"#
    do {
        try text.write(toFile: path, atomically: true, encoding: .utf8)
    } catch {
        fputs("failed to write permission status: \(error)\n", stderr)
        exit(1)
    }
}

private func runStdio() {
    fputs("Orca Computer Use provider must be launched by Orca in app-agent mode.\n", stderr)
    exit(13)
}

private func handleRequest(
    provider: Provider,
    lock: NSLock,
    request: Request,
    expectedToken: String?,
    authorizedPeer: Bool
) -> Any {
    if let expectedToken, request.token != expectedToken {
        return ["id": request.id, "ok": false, "error": ["code": "permission_denied", "message": "invalid computer-use agent token"]]
    }
    if expectedToken != nil && !authorizedPeer {
        return ["id": request.id, "ok": false, "error": ["code": "permission_denied", "message": "computer-use agent peer is not authorized"]]
    }
    if request.method == "terminate" {
        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
        return ["id": request.id, "ok": true, "result": ["ok": true]]
    }

    do {
        lock.lock()
        defer { lock.unlock() }
        let result = try provider.handle(method: request.method, params: request.params ?? [:])
        return ["id": request.id, "ok": true, "result": result]
    } catch let error as ProviderError {
        return ["id": request.id, "ok": false, "error": ["code": error.code, "message": error.message]]
    } catch {
        return ["id": request.id, "ok": false, "error": ["code": "accessibility_error", "message": String(describing: error)]]
    }
}

private func readLine(from fd: Int32) -> String? {
    var bytes: [UInt8] = []
    var byte: UInt8 = 0
    while true {
        let count = read(fd, &byte, 1)
        if count == 0 {
            return bytes.isEmpty ? nil : String(bytes: bytes, encoding: .utf8)
        }
        if count < 0 {
            return nil
        }
        if byte == 10 {
            return String(bytes: bytes, encoding: .utf8)
        }
        bytes.append(byte)
    }
}

private func writeJSON(_ object: Any, to fd: Int32?) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    else {
        return
    }
    if let fd {
        _ = writeAll(data, to: fd)
        _ = writeAll(Data([10]), to: fd)
    } else {
        guard let text = String(data: data, encoding: .utf8) else {
            return
        }
        print(text)
        fflush(stdout)
    }
}

private func writeAll(_ data: Data, to fd: Int32) -> Bool {
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else {
            return true
        }
        var offset = 0
        while offset < rawBuffer.count {
            let written = write(fd, baseAddress.advanced(by: offset), rawBuffer.count - offset)
            if written < 0 {
                if errno == EINTR {
                    continue
                }
                return false
            }
            if written == 0 {
                return false
            }
            offset += written
        }
        return true
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--agent" {
    guard arguments.count >= 2 else {
        fputs("usage: orca-computer-use-macos --agent <socket-path> --token-file <token-path>\n", stderr)
        exit(2)
    }
    let tokenFileIndex = arguments.firstIndex(of: "--token-file")
    let token = tokenFileIndex.flatMap { index -> String? in
        let valueIndex = index + 1
        guard valueIndex < arguments.count else { return nil }
        let tokenPath = arguments[valueIndex]
        defer { unlink(tokenPath) }
        return try? String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let token, !token.isEmpty else {
        fputs("orca-computer-use-macos --agent requires a non-empty --token-file\n", stderr)
        exit(2)
    }
    runAgent(socketPath: arguments[1], token: token)
} else if arguments.first == "--permissions" {
    runPermissionCheck()
} else if arguments.first == "--permission" {
    runPermissionCheck(initialPermission: PermissionKind.parse(arguments.dropFirst().first))
} else if arguments.first == "--permission-status" {
    printPermissionStatus()
} else if arguments.first == "--permission-status-file" {
    guard arguments.count >= 2 else {
        fputs("usage: orca-computer-use-macos --permission-status-file <path>\n", stderr)
        exit(2)
    }
    writePermissionStatus(to: arguments[1])
} else {
    runStdio()
}
