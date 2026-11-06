import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

/// Delivers pointer and key input to one window of an app without activating it, raising it,
/// changing the user's key window or moving the real pointer. It owns every private symbol it needs.
public enum BackgroundInputTransport {
    public struct Target: Equatable, Sendable {
        public let pid: pid_t
        public let windowID: CGWindowID
        /// Window frame in global top-left screen points, as CGWindowList reports it.
        public let windowFrame: CGRect

        public init(pid: pid_t, windowID: CGWindowID, windowFrame: CGRect) {
            self.pid = pid
            self.windowID = windowID
            self.windowFrame = windowFrame
        }
    }

    public enum Failure: Error, Equatable {
        case unavailable(missingSymbols: [String])
        case processNotFound
        case eventCreationFailed
        case targetWindowNotKey
        case focusRecordFailed(status: Int32)
    }

    /// What the app's accessibility tree has under a point, which decides how a pointer event may be sent.
    public enum PointerHit: Equatable, Sendable {
        /// WebKit content (Safari, WKWebView): drops clicks into a window that is not key.
        case webKitContent
        /// A popup menu or web `<select>`: a background click opens menu tracking off screen or wedges Chromium input.
        case popupMenu
        case other
    }

    /// Down/up pacing; WindowServer can drop a mouseUp that follows its mouseDown too closely.
    static let pressPauseMicroseconds: UInt32 = 28_000
    static let windowIDField = CGEventField(rawValue: 51)!

    public static var missingSymbols: [String] {
        PrivateSymbols.shared.missing
    }

    public static var isAvailable: Bool {
        missingSymbols.isEmpty
    }

    // MARK: Pointer

    public static func click(
        _ target: Target,
        at point: CGPoint,
        button: MouseButtonSelection,
        clickCount: Int,
        flags: CGEventFlags,
        hit: PointerHit
    ) throws {
        let symbols = try PrivateSymbols.shared.require()
        let clicks = {
            for clickState in 1...max(clickCount, 1) {
                try press(target, at: point, button: button, clickState: Int64(clickState), flags: flags, symbols: symbols)
            }
        }
        // Why: WebKit ignores the first click into a window that is not key.
        if hit == .webKitContent {
            try withKeyWindow(target, clicks)
        } else {
            try clicks()
        }
    }

    /// One down/up pair whose click state is its position in a double or triple click.
    public static func press(
        _ target: Target,
        at point: CGPoint,
        button: MouseButtonSelection,
        clickState: Int64,
        flags: CGEventFlags
    ) throws {
        try press(target, at: point, button: button, clickState: clickState, flags: flags, symbols: PrivateSymbols.shared.require())
    }

    public static func scroll(_ target: Target, at point: CGPoint, wheel1: Int32, wheel2: Int32, units: CGScrollEventUnit = .line) throws {
        let symbols = try PrivateSymbols.shared.require()
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: units,
            wheelCount: 2,
            wheel1: wheel1,
            wheel2: wheel2,
            wheel3: 0
        ) else {
            throw Failure.eventCreationFailed
        }
        stamp(event, target: target, at: point, symbols: symbols)
        event.postToPid(target.pid)
    }

    /// Runs inside the key-window scope: NSTextView only tracks a drag selection in a key window.
    /// Chromium still ignores it, because it reads the held button from the hardware state.
    public static func drag(_ target: Target, from start: CGPoint, to end: CGPoint) throws {
        let symbols = try PrivateSymbols.shared.require()
        try withKeyWindow(target) {
            try mouseEvent(.leftMouseDown, target: target, at: start, button: .left, clickState: 1, flags: [], symbols: symbols).postToPid(target.pid)
            usleep(pressPauseMicroseconds)
            for step in 1...10 {
                let progress = CGFloat(step) / 10
                let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
                try mouseEvent(.leftMouseDragged, target: target, at: point, button: .left, clickState: 1, flags: [], symbols: symbols).postToPid(target.pid)
                usleep(10_000)
            }
            try mouseEvent(.leftMouseUp, target: target, at: end, button: .left, clickState: 1, flags: [], symbols: symbols).postToPid(target.pid)
        }
    }

    /// Mouse event routed to `target`'s window: AppKit drops pid-posted mouse events unless field 51
    /// carries the window number and the window location is window-local (fields 91/92 do nothing).
    static func mouseEvent(
        _ type: CGEventType,
        target: Target,
        at point: CGPoint,
        button: MouseButtonSelection,
        clickState: Int64,
        flags: CGEventFlags
    ) throws -> CGEvent {
        try mouseEvent(type, target: target, at: point, button: button.cgButton, clickState: clickState, flags: flags, symbols: PrivateSymbols.shared.require())
    }

    public static func classifyPointerHit(_ element: AXUIElement) -> PointerHit {
        var current = element
        for depth in 0..<48 {
            let role = stringAttribute(current, kAXRoleAttribute as String)
            // Why: the hit lands on a popup's label or the popup itself, never deeper than its parent.
            if depth < 2, role == kAXPopUpButtonRole as String || role == kAXMenuButtonRole as String {
                return .popupMenu
            }
            if role == "AXWebArea" {
                // Why: Chromium accepts window-stamped clicks as is; only WebKit needs the key-window scope,
                // which fires the app's own did-become-active code (Slack, for one, marks messages read).
                return isChromiumNode(current) ? .other : .webKitContent
            }
            if role == kAXWindowRole as String { return .other }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let parent,
                  CFGetTypeID(parent) == AXUIElementGetTypeID()
            else {
                return .other
            }
            // SAFETY: the CFTypeID check above proves this is an AXUIElement.
            current = parent as! AXUIElement
        }
        return .other
    }

    // MARK: Keys

    /// Keys of a chord without a Unicode string: AppKit only matches menu key equivalents (⌘A/C/V/Z)
    /// when the key events carry none.
    public static func chordEvents(keyCode: CGKeyCode, modifiers: [(keyCode: CGKeyCode, flag: CGEventFlags)]) throws -> [CGEvent] {
        var events: [CGEvent] = []
        var flags = CGEventFlags()
        for modifier in modifiers {
            flags.insert(modifier.flag)
            events.append(try keyEvent(modifier.keyCode, down: true, flags: flags))
        }
        events.append(try keyEvent(keyCode, down: true, flags: flags))
        events.append(try keyEvent(keyCode, down: false, flags: flags))
        for modifier in modifiers.reversed() {
            flags.remove(modifier.flag)
            events.append(try keyEvent(modifier.keyCode, down: false, flags: flags))
        }
        return events
    }

    /// Unicode text as key events; the string rides the key-down only, or Electron inserts it twice (#17942).
    public static func textEvents(_ text: String) throws -> [CGEvent] {
        var events: [CGEvent] = []
        for character in text {
            var units = Array(String(character).utf16)
            let down = try keyEvent(0, down: true, flags: [])
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            events.append(down)
            events.append(try keyEvent(0, down: false, flags: []))
        }
        return events
    }

    /// Posts the keys to the pid while `target` is the app's key window.
    public static func sendKeys(_ events: [CGEvent], to target: Target) throws {
        try withKeyWindow(target) {
            for event in events {
                event.postToPid(target.pid)
            }
        }
    }

    /// Refuses to change an active app's key window; inactive apps receive a temporary key-window scope.
    static func withKeyWindow(_ target: Target, _ body: () throws -> Void) throws {
        let symbols = try PrivateSymbols.shared.require()
        let wasActive = NSRunningApplication(processIdentifier: target.pid)?.isActive == true
        if wasActive {
            let appElement = AXUIElementCreateApplication(target.pid)
            var focused: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focused) == .success,
                  let focused, CFGetTypeID(focused) == AXUIElementGetTypeID()
            else { throw Failure.targetWindowNotKey }
            // SAFETY: the CFTypeID check above proves focused is an AXUIElement.
            let window = focused as! AXUIElement
            guard let windowID = try? AccessibilityWindowIdentity.windowID(of: window),
                  windowID == target.windowID
            else { throw Failure.targetWindowNotKey }
            try body()
            return
        }
        var psn = ProcessSerialNumber()
        guard symbols.getProcessForPID(target.pid, &psn) == noErr else {
            throw Failure.processNotFound
        }
        func defocus() throws {
            // Why: focus records and input events travel different paths, so let the input arrive first.
            usleep(50_000)
            try postRecord(keyFocusRecord(windowID: target.windowID, focus: false), psn: psn, symbols: symbols)
        }
        do {
            try postRecord(keyFocusRecord(windowID: target.windowID, focus: true), psn: psn, symbols: symbols)
            usleep(20_000)
            for kind: UInt8 in [0x01, 0x02] {
                try postRecord(makeKeyRecord(windowID: target.windowID, kind: kind), psn: psn, symbols: symbols)
            }
            usleep(50_000)
            try body()
        } catch {
            try defocus()
            throw error
        }
        try defocus()
    }

    /// yabai/cua focus-without-raise record: 0x0d at 0x08, window id at 0x3c, 1 = focus / 2 = defocus at 0x8a.
    static func keyFocusRecord(windowID: CGWindowID, focus: Bool) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        writeWindowID(windowID, into: &record)
        record[0x8A] = focus ? 0x01 : 0x02
        return record
    }

    /// yabai/cua make-key record; posted as the 0x01/0x02 pair after the focus record.
    static func makeKeyRecord(windowID: CGWindowID, kind: UInt8) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = kind
        record[0x3A] = 0x10
        writeWindowID(windowID, into: &record)
        for index in 0x20..<0x30 {
            record[index] = 0xFF
        }
        return record
    }

    // MARK: Internals

    private static func press(
        _ target: Target,
        at point: CGPoint,
        button: MouseButtonSelection,
        clickState: Int64,
        flags: CGEventFlags,
        symbols: PrivateSymbols.Loaded
    ) throws {
        try mouseEvent(button.downEvent, target: target, at: point, button: button.cgButton, clickState: clickState, flags: flags, symbols: symbols).postToPid(target.pid)
        usleep(pressPauseMicroseconds)
        try mouseEvent(button.upEvent, target: target, at: point, button: button.cgButton, clickState: clickState, flags: flags, symbols: symbols).postToPid(target.pid)
        usleep(pressPauseMicroseconds)
    }

    private static func mouseEvent(
        _ type: CGEventType,
        target: Target,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int64,
        flags: CGEventFlags,
        symbols: PrivateSymbols.Loaded
    ) throws -> CGEvent {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw Failure.eventCreationFailed
        }
        event.flags = flags
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        stamp(event, target: target, at: point, symbols: symbols)
        return event
    }

    private static func stamp(_ event: CGEvent, target: Target, at point: CGPoint, symbols: PrivateSymbols.Loaded) {
        event.location = point
        event.setIntegerValueField(windowIDField, value: Int64(target.windowID))
        symbols.setWindowLocation(event, CGPoint(x: point.x - target.windowFrame.minX, y: point.y - target.windowFrame.minY))
    }

    private static func postRecord(_ record: [UInt8], psn: ProcessSerialNumber, symbols: PrivateSymbols.Loaded) throws {
        var record = record
        var recordPSN = psn
        let status = symbols.postEventRecordTo(&recordPSN, &record)
        guard status == noErr else { throw Failure.focusRecordFailed(status: status) }
    }

    private static func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) throws -> CGEvent {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else {
            throw Failure.eventCreationFailed
        }
        event.flags = flags
        return event
    }

    private static func writeWindowID(_ windowID: CGWindowID, into record: inout [UInt8]) {
        withUnsafeBytes(of: windowID.littleEndian) { bytes in
            for (offset, byte) in bytes.enumerated() {
                record[0x3C + offset] = byte
            }
        }
    }

    private static func isChromiumNode(_ element: AXUIElement) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success, let names = names as? [String] else {
            return false
        }
        return names.contains("ChromeAXNodeId")
    }

    private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }
}

extension MouseButtonSelection {
    // Why: macOS has no dedicated middle-button event family; it rides `otherMouse*`
    // with the button number carried by `mouseButton:` on the event constructor.
    public var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    public var downEvent: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    public var upEvent: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
}

/// Private CoreGraphics/SkyLight/HIServices symbols, resolved once with dlsym (SIP stays on).
private final class PrivateSymbols: Sendable {
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    typealias PostEventRecordTo = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<UInt8>) -> Int32
    typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus

    struct Loaded: Sendable {
        let setWindowLocation: SetWindowLocation
        let postEventRecordTo: PostEventRecordTo
        let getProcessForPID: GetProcessForPID
    }

    static let shared = PrivateSymbols()

    let loaded: Loaded?
    let missing: [String]

    private init() {
        let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        let applicationServices = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
        var missing: [String] = []
        func resolve<T>(_ handle: UnsafeMutableRawPointer?, _ name: String, as type: T.Type) -> T? {
            guard let symbol = dlsym(handle, name) ?? dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else {
                missing.append(name)
                return nil
            }
            // SAFETY: each name is a C function whose ABI matches `type` (checked against the SDK and cua/yabai).
            return unsafeBitCast(symbol, to: type)
        }
        let setWindowLocation = resolve(skyLight, "CGEventSetWindowLocation", as: SetWindowLocation.self)
        let postEventRecordTo = resolve(skyLight, "SLPSPostEventRecordTo", as: PostEventRecordTo.self)
        let getProcessForPID = resolve(applicationServices, "GetProcessForPID", as: GetProcessForPID.self)
        if let setWindowLocation, let postEventRecordTo, let getProcessForPID {
            loaded = Loaded(setWindowLocation: setWindowLocation, postEventRecordTo: postEventRecordTo, getProcessForPID: getProcessForPID)
        } else {
            loaded = nil
        }
        self.missing = missing
    }

    func require() throws -> Loaded {
        guard let loaded else {
            throw BackgroundInputTransport.Failure.unavailable(missingSymbols: missing)
        }
        return loaded
    }
}
