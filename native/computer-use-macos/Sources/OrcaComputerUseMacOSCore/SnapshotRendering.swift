import Foundation

public struct SnapshotRenderNode: Equatable {
    public var role: String
    public var roleDescription: String?
    public var title: String?
    public var label: String?
    public var linkText: String?
    public var value: String?
    public var placeholder: String?
    public var url: String?
    public var traits: [String]
    public var rawActions: [String]
    public var childCount: Int
    public var summary: String?
    public var rowSummary: String?
    public var webAreaDepth: Int?

    public init(
        role: String,
        roleDescription: String? = nil,
        title: String? = nil,
        label: String? = nil,
        linkText: String? = nil,
        value: String? = nil,
        placeholder: String? = nil,
        url: String? = nil,
        traits: [String] = [],
        rawActions: [String] = [],
        childCount: Int = 0,
        summary: String? = nil,
        rowSummary: String? = nil,
        webAreaDepth: Int? = nil
    ) {
        self.role = role
        self.roleDescription = roleDescription
        self.title = title
        self.label = label
        self.linkText = linkText
        self.value = value
        self.placeholder = placeholder
        self.url = url
        self.traits = traits
        self.rawActions = rawActions
        self.childCount = childCount
        self.summary = summary
        self.rowSummary = rowSummary
        self.webAreaDepth = webAreaDepth
    }
}

public enum SnapshotRenderHeuristics {
    public static func displayName(_ node: SnapshotRenderNode) -> String? {
        if let title = clean(node.title) {
            return title
        }
        if node.role == "AXLink", let url = clean(node.url), let text = clean(node.linkText ?? node.label ?? node.value) {
            return "[\(markdownEscaped(text))](\(url))"
        }
        if node.role == "AXWebArea" {
            return clean(node.label) ?? clean(node.value)
        }
        if ["AXButton", "AXPopUpButton", "AXImage"].contains(node.role) {
            return clean(node.label)
        }
        if ["AXRow", "AXCell", "AXOutlineRow"].contains(node.role) {
            return clean(node.rowSummary)
        }
        return clean(node.label)
    }

    public static func meaningfulActions(_ rawActions: [String], role: String) -> [String] {
        let noisy: Set<String> = [
            "AXPress",
            "AXShowDefaultUI",
            "AXShowAlternateUI",
            "AXShowMenu",
            "AXScrollToVisible",
            "AXConfirm",
            "AXRaise",
        ]
        return rawActions.filter { action in
            if noisy.contains(action) { return false }
            if role == "AXMenu" || role == "AXMenuItem" {
                return action != "AXCancel" && action != "AXPick"
            }
            if role == "AXScrollArea",
               (rawActions.contains("AXScrollUpByPage") || rawActions.contains("AXScrollDownByPage")),
               action == "AXScrollLeftByPage" || action == "AXScrollRightByPage" {
                return false
            }
            return true
        }
    }

    public static func shouldElide(_ node: SnapshotRenderNode) -> Bool {
        guard node.role == "AXGroup" || node.role == "AXUnknown" else { return false }
        guard displayName(node) == nil,
              node.traits.isEmpty,
              meaningfulActions(node.rawActions, role: node.role).isEmpty,
              clean(node.summary) == nil
        else {
            return false
        }
        if node.webAreaDepth != nil, node.childCount > 1 {
            return false
        }
        return true
    }

    public static func shouldSuppressChildren(_ node: SnapshotRenderNode) -> Bool {
        if node.role == "AXMenuBarItem" {
            return true
        }
        let name = displayName(node)
        if node.role == "AXLink" && name?.hasPrefix("[") == true {
            return true
        }
        let hasCompactLabel = name != nil || clean(node.value) != nil || clean(node.summary) != nil
        return hasCompactLabel && compactControlRoles.contains(node.role)
    }

    public static func shouldSuppressChildren(role: String, name: String? = nil) -> Bool {
        shouldSuppressChildren(SnapshotRenderNode(role: role, title: name))
    }

    public static func line(index: Int, node: SnapshotRenderNode) -> String {
        let name = displayName(node)
        let roleText = roleText(node)
        let meaningful = meaningfulActions(node.rawActions, role: node.role)
        var line = roleText.isEmpty ? "\(index)" : "\(index) \(roleText)"
        if !node.traits.isEmpty { line += " (\(node.traits.joined(separator: ", ")))" }
        if let name { line += " \(sanitize(name))" }
        if node.role != "AXLink", let description = clean(node.label), description != name {
            line += ", Description: \(sanitize(description))"
        }
        if let valueSegment = formattedValueSegment(roleText: roleText, name: name, value: node.value) {
            line += valueSegment
        }
        if let placeholder = clean(node.placeholder), placeholder != name, placeholder != node.value {
            line += name == nil && clean(node.value) == nil ? " Placeholder: \(sanitize(placeholder))" : ", Placeholder: \(sanitize(placeholder))"
        }
        if let summary = clean(node.summary), summary != name {
            line += ", Text: \(sanitize(summary))"
        } else if let rowSummary = clean(node.rowSummary), rowSummary != name {
            line += ", Text: \(sanitize(rowSummary))"
        }
        if !meaningful.isEmpty {
            line += ", Secondary Actions: \(meaningful.map(prettyAction).joined(separator: ", "))"
        }
        return line
    }

    public static func roleText(_ node: SnapshotRenderNode) -> String {
        if node.role == "AXGroup" || node.role == "AXUnknown" {
            return "container"
        }
        if node.role == "AXLink" {
            return "link"
        }
        if node.role == "AXWebArea" {
            return clean(node.roleDescription) ?? "html content"
        }
        if node.role == "AXMenuBarItem" {
            return ""
        }
        if let value = clean(node.roleDescription) {
            return value.lowercased()
        }
        if node.role.hasPrefix("AX") {
            return splitCamelCase(String(node.role.dropFirst(2))).lowercased()
        }
        return node.role
    }

    public static func prettyAction(_ action: String) -> String {
        if action == "AXZoomWindow" {
            return "zoom the window"
        }
        let stripped = action.hasPrefix("AX") ? String(action.dropFirst(2)) : action
        return splitCamelCase(stripped.replacingOccurrences(of: "ByPage", with: "")).lowercased()
    }

    public static func sanitize(_ value: String) -> String {
        value.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let sanitized = sanitize(value)
        return sanitized.isEmpty ? nil : sanitized
    }

    private static func formattedValueSegment(roleText: String, name: String?, value: String?) -> String? {
        guard let value = clean(value), value != name else { return nil }
        if roleText == "heading", Int(value) != nil {
            return nil
        }
        let clean = sanitize(value)
        if roleText == "text" || roleText == "text entry area" || roleText == "scroll bar" || roleText == "value indicator" {
            return " \(clean)"
        }
        return ", Value: \(clean)"
    }

    private static func markdownEscaped(_ value: String) -> String {
        sanitize(value)
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private static func splitCamelCase(_ value: String) -> String {
        var result = ""
        for character in value {
            if character.isUppercase, !result.isEmpty {
                result.append(" ")
            }
            result.append(character)
        }
        return result
    }

    private static let compactControlRoles: Set<String> = [
        "AXButton",
        "AXCheckBox",
        "AXComboBox",
        "AXDisclosureTriangle",
        "AXHeading",
        "AXMenuItem",
        "AXPopUpButton",
        "AXRadioButton",
        "AXStaticText",
        "AXTab",
    ]
}
