import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// Finds an app's accessibility windows on other Spaces, which `kAXWindowsAttribute` leaves out,
/// by rebuilding element references from remote tokens (the technique AltTab uses).
/// Only finds windows some accessibility client has read before: an app numbers its elements in the order it first hands them out.
public enum RemoteAccessibilityWindows {
    /// Windows are usually handed out first (ids 42-73 measured in apps open for days); a window first read after
    /// a large tree walk gets a later id.
    static let elementIdLimit: UInt64 = 20_000
    /// About 12 µs per id; the budget bounds a slow app.
    static let scanBudgetSeconds: CFAbsoluteTime = 0.5

    /// The windows of `pid` whose window ids are in `wanted`.
    public static func windows(pid: pid_t, wanted: Set<CGWindowID>) -> [CGWindowID: AXUIElement] {
        guard let createWithRemoteToken, !wanted.isEmpty else { return [:] }
        let deadline = CFAbsoluteTimeGetCurrent() + scanBudgetSeconds
        var found: [CGWindowID: AXUIElement] = [:]
        for elementId in 0..<elementIdLimit where CFAbsoluteTimeGetCurrent() < deadline {
            guard let element = createWithRemoteToken(token(pid: pid, elementId: elementId) as CFData)?.takeRetainedValue() else {
                continue
            }
            var role: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
            // Why: an app that stops answering would otherwise cost the AX timeout for every remaining id.
            if status == .cannotComplete { break }
            guard status == .success, role as? String == kAXWindowRole as String,
                  let windowID = try? AccessibilityWindowIdentity.windowID(of: element),
                  wanted.contains(windowID)
            else { continue }
            found[windowID] = element
            if found.count == wanted.count { break }
        }
        return found
    }

    /// The pid, a zero word, the "coco" tag, then the element id.
    static func token(pid: pid_t, elementId: UInt64) -> Data {
        var token = Data()
        withUnsafeBytes(of: pid.littleEndian) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0)) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: Int32(0x636F_636F).littleEndian) { token.append(contentsOf: $0) }
        withUnsafeBytes(of: elementId.littleEndian) { token.append(contentsOf: $0) }
        return token
    }

    private typealias CreateWithRemoteToken = @convention(c) (CFData) -> Unmanaged<AXUIElement>?

    private static let createWithRemoteToken: CreateWithRemoteToken? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementCreateWithRemoteToken") else { return nil }
        // SAFETY: HIServices exports AXUIElementRef _AXUIElementCreateWithRemoteToken(CFDataRef), returning a +1 reference.
        return unsafeBitCast(symbol, to: CreateWithRemoteToken.self)
    }()
}
