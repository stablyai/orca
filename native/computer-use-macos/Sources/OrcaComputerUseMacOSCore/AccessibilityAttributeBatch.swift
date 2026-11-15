import ApplicationServices
import Foundation

/// Reads the attributes the snapshot walker needs on nearly every node in one accessibility round trip.
public enum AccessibilityAttributeBatch {
    /// Leaves out AXValue: the walker reads it only after ruling out a secure text field, so a password's value
    /// is never copied into this process. AXRows stays lazy too, since only tables and outlines use it.
    public static let snapshotAttributes: [String] = [
        kAXRoleAttribute as String,
        kAXSubroleAttribute as String,
        kAXRoleDescriptionAttribute as String,
        kAXTitleAttribute as String,
        kAXDescriptionAttribute as String,
        "AXPlaceholderValue",
        "AXPlaceholder",
        kAXURLAttribute as String,
        kAXSelectedAttribute as String,
        kAXExpandedAttribute as String,
        kAXEnabledAttribute as String,
        kAXPositionAttribute as String,
        kAXSizeAttribute as String,
        kAXChildrenAttribute as String,
    ]

    /// The snapshot attributes this element advertises; empty when it did not list its attributes,
    /// so the caller keeps reading one attribute at a time as before.
    public static func attributesToPrefetch(advertised: Set<String>?) -> [String] {
        guard let advertised else { return [] }
        return snapshotAttributes.filter { advertised.contains($0) }
    }

    /// Maps the array AXUIElementCopyMultipleAttributeValues returns back to its attributes. A slot holding an
    /// AXError (or null) is an attribute with no value. Returns nil when the array does not line up with the request.
    public static func decode(requested: [String], values: [AnyObject]?) -> [String: CFTypeRef?]? {
        guard let values, values.count == requested.count else { return nil }
        var decoded: [String: CFTypeRef?] = [:]
        for (attribute, value) in zip(requested, values) {
            // Why: the key must stay, with a nil value, so the caller caches the attribute as missing.
            decoded.updateValue(isMissing(value) ? nil : value, forKey: attribute)
        }
        return decoded
    }

    private static func isMissing(_ value: AnyObject) -> Bool {
        let typeID = CFGetTypeID(value)
        if typeID == CFNullGetTypeID() {
            return true
        }
        return typeID == AXValueGetTypeID() && AXValueGetType(value as! AXValue) == .axError
    }
}
