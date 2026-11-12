/// The accessibility reads and writes a row click needs, so the click policy runs against a fake tree in tests.
public protocol RowSelectionAccessibility {
    associatedtype Element
    func role(of element: Element) -> String?
    func isSelected(_ element: Element) -> Bool?
    func parent(of element: Element) -> Element?
    func isSettable(_ attribute: String, on element: Element) -> Bool
    /// Sets AXSelected to true; false when the app refused the write.
    func setSelected(_ element: Element) throws -> Bool
    /// Replaces the container's selection with the member; false when the app refused the write.
    func setSelection(_ attribute: String, of container: Element, to member: Element) throws -> Bool
    /// Re-checks for a moment, since apps apply a selection on a later run-loop turn.
    func settles(_ check: () -> Bool) -> Bool
}

/// A plain click on a list, table or outline row means "select it", yet AXPress on a row often answers
/// success and selects nothing. For a row that read unselected, the selection reading back on is what
/// makes the click count.
public enum RowSelectionClick {
    public static let rowRoles: Set<String> = ["AXRow", "AXCell", "AXOutlineRow"]
    static let containerRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXGrid"]
    static let maxContainerDepth = 6

    public enum Outcome: Equatable {
        case selectedByClick
        case selectedByWrite(attribute: String)
        case unselected
    }

    /// Rows that read selected already, or publish no selection, prove nothing by reading selected afterwards.
    public static func isUnselectedRow<AX: RowSelectionAccessibility>(_ element: AX.Element, ax: AX) -> Bool {
        guard let role = ax.role(of: element), rowRoles.contains(role) else { return false }
        return selectionShows(element, ax: ax) == false
    }

    /// Call after a click reached the app. A selection write is idempotent, so it is safe even when the
    /// click did something else; it still comes second because it skips the app's own click handling.
    public static func confirm<AX: RowSelectionAccessibility>(_ element: AX.Element, ax: AX) throws -> Outcome {
        if ax.settles({ selectionShows(element, ax: ax) == true }) {
            return .selectedByClick
        }
        guard let attribute = try writeSelection(element, ax: ax),
              ax.settles({ selectionShows(element, ax: ax) == true })
        else {
            return .unselected
        }
        return .selectedByWrite(attribute: attribute)
    }

    /// A cell in a table that selects whole rows reads selected through its row.
    static func selectionShows<AX: RowSelectionAccessibility>(_ element: AX.Element, ax: AX) -> Bool? {
        let own = ax.isSelected(element)
        guard own != true, let row = enclosingRow(of: element, ax: ax) else { return own }
        let rowSelected = ax.isSelected(row)
        return rowSelected == true ? true : own ?? rowSelected
    }

    /// Returns the first write the app accepted. It stops there: a selection that has not shown yet may
    /// still land, and a second write could then select something else.
    private static func writeSelection<AX: RowSelectionAccessibility>(_ element: AX.Element, ax: AX) throws -> String? {
        let row = enclosingRow(of: element, ax: ax)
        let isCell = ax.role(of: element) == "AXCell"
        var child = element
        for _ in 0..<maxContainerDepth {
            guard let parent = ax.parent(of: child) else { break }
            guard let role = ax.role(of: parent), containerRoles.contains(role) else {
                child = parent
                continue
            }
            // Why: a spreadsheet owns cell selection on AXSelectedCells; a table that selects rows takes the
            // cell's row; AXSelectedChildren only takes the container's own children.
            let writes: [(String, AX.Element)] = (isCell ? [("AXSelectedCells", element)] : []) + [("AXSelectedRows", row ?? element), ("AXSelectedChildren", child)]
            for (attribute, member) in writes where ax.isSettable(attribute, on: parent) {
                if try ax.setSelection(attribute, of: parent, to: member) {
                    return attribute
                }
            }
            // Why: an outer list's selection is not this row's; writing it would change something else.
            break
        }
        // Why: last, because in a multi-select list AXSelected may add the row to the selection instead of replacing it.
        for target in [element, row].compactMap({ $0 }) where ax.isSettable("AXSelected", on: target) {
            if try ax.setSelected(target) {
                return "AXSelected"
            }
        }
        return nil
    }

    private static func enclosingRow<AX: RowSelectionAccessibility>(of element: AX.Element, ax: AX) -> AX.Element? {
        guard ax.role(of: element) == "AXCell",
              let parent = ax.parent(of: element),
              let parentRole = ax.role(of: parent),
              parentRole != "AXCell",
              rowRoles.contains(parentRole)
        else {
            return nil
        }
        return parent
    }
}
