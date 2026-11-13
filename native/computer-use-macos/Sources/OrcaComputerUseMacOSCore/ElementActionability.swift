import CoreGraphics

/// The accessibility reads an element action needs before it sends input, so the policy runs against a fake tree in tests.
public protocol ElementActionabilityAccessibility {
    associatedtype Element
    /// AXEnabled; nil when the element does not publish it.
    func isEnabled(_ element: Element) -> Bool?
    /// Frame in global top-left screen points.
    func frame(of element: Element) -> CGRect?
    func role(of element: Element) -> String?
    func parent(of element: Element) -> Element?
    func isSame(_ lhs: Element, _ rhs: Element) -> Bool
    /// AXModal: an app-modal window blocks input to the app's other windows.
    func isModal(_ window: Element) -> Bool
    /// The target app's own topmost element at a screen point; nil when the app cannot say.
    func element(at point: CGPoint) -> Element?
    /// Asks the app to scroll the element into view; false when the element does not offer that.
    func scrollToVisible(_ element: Element) throws -> Bool
    /// Pauses before the next check; false once the wait budget is spent.
    func waitBeforeRetry() -> Bool
}

/// Checks that an element can take an action before any input is sent: it is enabled and, for pointer
/// input, it is in view (scrolled there if needed) and is what the app hit-tests under the click point.
public enum ElementActionability {
    public enum PointerTarget<Element> {
        case ready(CGPoint)
        case notEnabled
        case noFrame
        /// Nothing of the element shows inside its window and scroll areas.
        case outOfView(scrolled: Bool)
        /// Another element is on top at every point tried.
        case covered(by: Element)
    }

    static let maxAncestorDepth = 64

    /// Waits briefly for a disabled element to enable; an element that publishes no AXEnabled counts as enabled.
    public static func waitUntilEnabled<AX: ElementActionabilityAccessibility>(_ element: AX.Element, ax: AX) -> Bool {
        while ax.isEnabled(element) == false {
            guard ax.waitBeforeRetry() else { return false }
        }
        return true
    }

    /// Where a pointer click on the element lands, re-checked until it holds or the wait budget runs out.
    public static func pointerTarget<AX: ElementActionabilityAccessibility>(
        _ element: AX.Element,
        windowFrame: CGRect,
        ax: AX
    ) throws -> PointerTarget<AX.Element> {
        var scrolled = false
        var scrollTried = false
        var settledFrame: CGRect?
        var last: PointerTarget<AX.Element> = .noFrame
        // Why: one scroll at most, so a target that keeps failing cannot scroll the user's view around.
        func scrollOnce() throws -> Bool {
            guard !scrollTried else { return false }
            scrollTried = true
            scrolled = try ax.scrollToVisible(element)
            return scrolled
        }
        repeat {
            guard ax.isEnabled(element) != false else {
                last = .notEnabled
                continue
            }
            guard let frame = ax.frame(of: element), frame.width > 0, frame.height > 0 else {
                return .noFrame
            }
            // Why: a scroll can animate, and a click mid-animation lands where the element used to be.
            if scrolled, settledFrame.map({ !framesMatch($0, frame) }) ?? true {
                settledFrame = frame
                last = .outOfView(scrolled: true)
                continue
            }
            let (clip, ancestors) = clipRect(of: element, windowFrame: windowFrame, ax: ax)
            let visible = frame.intersection(clip)
            // Why: an element bigger than its viewport cannot be brought fully into view, so it is clicked where it shows.
            let fits = frame.width <= clip.width && frame.height <= clip.height
            if visible.isEmpty || (fits && !visible.contains(CGPoint(x: frame.midX, y: frame.midY))), try scrollOnce() {
                last = .outOfView(scrolled: true)
                continue
            }
            guard !visible.isEmpty else {
                last = .outOfView(scrolled: scrolled)
                if scrolled { continue }
                return last
            }
            switch hitTarget(element, visible: visible, ancestors: ancestors, ax: ax) {
            case let .direct(point):
                return .ready(point)
            case let .ancestorOnly(point):
                // Why: a scroller not exposed as AXScrollArea (a web overflow div) can hide the element behind its own container.
                guard try scrollOnce() else { return .ready(point) }
                last = .outOfView(scrolled: true)
            case let .covered(by: cover):
                last = .covered(by: cover)
                // Why: a table or sticky header inside the scroll area can cover a row that scrolling would clear.
                _ = try scrollOnce()
            }
        } while ax.waitBeforeRetry()
        return last
    }

    /// The part of the screen the element can show in (its window and every scroll area it sits in), plus its ancestors.
    static func clipRect<AX: ElementActionabilityAccessibility>(
        of element: AX.Element,
        windowFrame: CGRect,
        ax: AX
    ) -> (CGRect, [AX.Element]) {
        var visible = windowFrame
        var ancestors: [AX.Element] = []
        var current = element
        for _ in 0..<maxAncestorDepth {
            guard let parent = ax.parent(of: current) else { break }
            ancestors.append(parent)
            let role = ax.role(of: parent)
            if role == "AXScrollArea", let clip = ax.frame(of: parent) {
                visible = visible.intersection(clip)
            }
            if role == "AXWindow" { break }
            current = parent
        }
        return (visible, ancestors)
    }

    enum Hit<Element> {
        /// The element, inside it, or a hit that shows nothing covers it.
        case direct(CGPoint)
        /// Only the element's own ancestors answered, as when it is see-through to hit tests.
        case ancestorOnly(CGPoint)
        case covered(by: Element)
    }

    static func hitTarget<AX: ElementActionabilityAccessibility>(
        _ element: AX.Element,
        visible: CGRect,
        ancestors: [AX.Element],
        ax: AX
    ) -> Hit<AX.Element> {
        var ancestorPoint: CGPoint?
        var coveredBy: AX.Element?
        for point in candidatePoints(in: visible) {
            guard let hit = ax.element(at: point) else { return .direct(point) }
            switch owner(of: hit, element, ancestors: ancestors, ax: ax) {
            case .clear:
                return .direct(point)
            case .ancestor:
                ancestorPoint = ancestorPoint ?? point
            case .cover:
                coveredBy = coveredBy ?? hit
            }
        }
        if let ancestorPoint { return .ancestorOnly(ancestorPoint) }
        // SAFETY: candidatePoints is never empty, so a loop without a direct or ancestor hit recorded a cover.
        return .covered(by: coveredBy!)
    }

    private enum HitOwner {
        /// The element, inside it, or a hit that shows nothing of the target window is on top.
        case clear
        case ancestor
        case cover
    }

    private static func owner<AX: ElementActionabilityAccessibility>(
        of hit: AX.Element,
        _ element: AX.Element,
        ancestors: [AX.Element],
        ax: AX
    ) -> HitOwner {
        if ancestors.contains(where: { ax.isSame($0, hit) }) { return .ancestor }
        var current = hit
        for _ in 0..<maxAncestorDepth {
            if ax.isSame(current, element) { return .clear }
            // Why: reaching the element's own container first means the hit sits beside the element, on top of it.
            if ancestors.contains(where: { ax.isSame($0, current) }) { return .cover }
            switch ax.role(of: current) {
            case "AXWindow":
                // Why: the app hit-tests its topmost window, but background input is stamped with the target window,
                // so only a modal window on top blocks it; the foreground fence checks other windows on top.
                return ax.isModal(current) ? .cover : .clear
            case "AXApplication":
                // Why: the app found none of its windows there (hidden, minimized, another Space), which says nothing.
                return .clear
            default:
                break
            }
            guard let parent = ax.parent(of: current) else { return .cover }
            current = parent
        }
        return .cover
    }

    /// The centre first, then the middle of each quadrant, so a partly covered element is still reachable.
    static func candidatePoints(in rect: CGRect) -> [CGPoint] {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let quarters = [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)].map {
            CGPoint(x: rect.minX + rect.width * $0.0, y: rect.minY + rect.height * $0.1)
        }
        return [center] + quarters
    }

    private static func framesMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 0.5 && abs(lhs.minY - rhs.minY) < 0.5
            && abs(lhs.width - rhs.width) < 0.5 && abs(lhs.height - rhs.height) < 0.5
    }
}
