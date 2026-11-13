import Foundation

/// What an action would put in front of the user. Without --restore-window an action with an effect
/// is refused before anything is sent. Design follows agent-desktop's `background_effect.rs` (Apache-2.0).
public enum ForegroundEffect: Equatable, Sendable {
    /// A menu drawn over the user's window that takes their keyboard; AppKit has no background route to its items.
    case showsMenu
    /// A button whose title ends in an ellipsis, the platform convention for "opens a dialog or sheet",
    /// which can activate the app. A predictor, not a proof: no accessibility attribute says so.
    case opensDialog

    static let menuOwnerRoles: Set<String> = ["AXPopUpButton", "AXMenuButton", "AXComboBox"]
    static let ellipses = ["\u{2026}", "..."]

    /// The effect of a press (AXPress or a left click) on an element, given its role and title or
    /// description, then its parent's; a hit on a popup's label lands one level below the popup.
    public static func ofPress(_ chain: [(role: String?, labels: [String?])]) -> ForegroundEffect? {
        for node in chain.prefix(2) {
            guard let role = node.role else { continue }
            if menuOwnerRoles.contains(role) { return .showsMenu }
            // Why: only buttons, so a truncated "Loading..." text or a "Read more..." link still clicks.
            if role == "AXButton", node.labels.contains(where: endsInEllipsis) { return .opensDialog }
        }
        return nil
    }

    /// A right-click, or a Control-click, opens the context menu; any other click presses the target.
    public static func ofClick(button: MouseButtonSelection, control: Bool, target chain: [(role: String?, labels: [String?])]) -> ForegroundEffect? {
        button == .right || (button == .left && control) ? .showsMenu : ofPress(chain)
    }

    /// The effect of an accessibility action run on its own, as perform-secondary-action does.
    public static func ofAction(_ action: String, target chain: [(role: String?, labels: [String?])]) -> ForegroundEffect? {
        switch action {
        case "AXShowMenu": return .showsMenu
        case "AXPress", "AXPick": return ofPress(chain)
        default: return nil
        }
    }

    static func endsInEllipsis(_ label: String?) -> Bool {
        guard let label else { return false }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return ellipses.contains { trimmed.hasSuffix($0) }
    }
}
