import AppKit
import CoreGraphics
import Darwin
import OrcaComputerUseMacOSCore

enum PointerVisibility {
    private static let approachSteps = 12
    private static let approachDelayMicroseconds: useconds_t = 8_000
    private static let actionDelayMicroseconds: useconds_t = 12_000
    private static let overlay = AgentPointerOverlayController()

    static func move(to destination: CGPoint) {
        let origin = overlay.currentQuartzPoint ?? destination
        if abs(origin.x - destination.x) + abs(origin.y - destination.y) < 1 {
            overlay.move(to: destination)
            return
        }
        for point in PointerMotionPath.points(from: origin, to: destination, steps: approachSteps) {
            overlay.move(to: point)
            usleep(approachDelayMicroseconds)
        }
    }

    static func indicateAction(at point: CGPoint) {
        overlay.indicateAction(at: point)
    }

    static func press(at point: CGPoint) {
        overlay.setPressed(true, at: point)
    }

    static func followAction(to destination: CGPoint) {
        overlay.setPressed(true, at: destination)
        usleep(actionDelayMicroseconds)
    }

    static func release(at point: CGPoint) {
        overlay.setPressed(false, at: point)
        overlay.indicateAction(at: point)
    }
}

private final class AgentPointerOverlayController: @unchecked Sendable {
    private static let panelSize = CGSize(width: 64, height: 64)
    private static let hotSpot = CGPoint(x: 20, y: 44)
    private let stateLock = NSLock()
    private var quartzPoint: CGPoint?
    private var hideGeneration = 0
    private var panel: NSPanel?
    private var pointerView: AgentPointerView?

    var currentQuartzPoint: CGPoint? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return quartzPoint
    }

    func move(to point: CGPoint) {
        update(point: point, pressed: false, pulse: false)
    }

    func indicateAction(at point: CGPoint) {
        update(point: point, pressed: false, pulse: true)
    }

    func setPressed(_ pressed: Bool, at point: CGPoint) {
        update(point: point, pressed: pressed, pulse: pressed)
    }

    private func update(point: CGPoint, pressed: Bool, pulse: Bool) {
        stateLock.lock()
        quartzPoint = point
        hideGeneration += 1
        let generation = hideGeneration
        stateLock.unlock()

        if Thread.isMainThread {
            MainActor.assumeIsolated {
                applyUIUpdate(point: point, pressed: pressed, pulse: pulse)
            }
        } else {
            DispatchQueue.main.sync { [self] in
                MainActor.assumeIsolated {
                    applyUIUpdate(point: point, pressed: pressed, pulse: pulse)
                }
            }
        }

        schedulePulseReset(generation: generation, pressed: pressed)
        scheduleHide(generation: generation)
    }

    @MainActor
    private func applyUIUpdate(point: CGPoint, pressed: Bool, pulse: Bool) {
        let panel = ensurePanel()
        let mainDisplayMaxY = primaryScreen()?.frame.maxY ?? NSScreen.screens.first?.frame.maxY ?? 0
        panel.setFrameOrigin(
            PointerOverlayGeometry.windowOrigin(
                forQuartzPoint: point,
                primaryDisplayMaxY: mainDisplayMaxY,
                hotSpot: Self.hotSpot
            )
        )
        pointerView?.setState(pressed: pressed, pulse: pulse)
        panel.orderFrontRegardless()
    }

    @MainActor
    private func ensurePanel() -> NSPanel {
        if let panel { return panel }

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.panelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        let pointerView = AgentPointerView(frame: NSRect(origin: .zero, size: Self.panelSize))
        panel.contentView = pointerView
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Why: the overlay explains actions to the human, but model screenshots
        // must remain an unannotated view of the target application.
        panel.sharingType = .none
        self.panel = panel
        self.pointerView = pointerView
        return panel
    }

    @MainActor
    private func primaryScreen() -> NSScreen? {
        NSScreen.screens.first { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                return false
            }
            return CGDirectDisplayID(number.uint32Value) == CGMainDisplayID()
        }
    }

    private func schedulePulseReset(generation: Int, pressed: Bool) {
        guard !pressed else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self, self.isCurrent(generation) else { return }
            self.pointerView?.setState(pressed: false, pulse: false)
        }
    }

    private func scheduleHide(generation: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, self.isCurrent(generation) else { return }
            self.panel?.orderOut(nil)
        }
    }

    private func isCurrent(_ generation: Int) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return generation == hideGeneration
    }
}

private final class AgentPointerView: NSView {
    private var isPressed = false
    private var showsPulse = false

    override var isOpaque: Bool { false }

    func setState(pressed: Bool, pulse: Bool) {
        isPressed = pressed
        showsPulse = pulse
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        dirtyRect.fill()

        if showsPulse {
            let ring = NSBezierPath(ovalIn: NSRect(x: 7, y: 31, width: 26, height: 26))
            ring.lineWidth = isPressed ? 3 : 2
            NSColor.controlAccentColor.withAlphaComponent(isPressed ? 0.9 : 0.72).setStroke()
            ring.stroke()
        }

        let pointer = NSBezierPath()
        pointer.move(to: NSPoint(x: 20, y: 44))
        pointer.line(to: NSPoint(x: 20, y: 16))
        pointer.line(to: NSPoint(x: 26, y: 22))
        pointer.line(to: NSPoint(x: 31, y: 11))
        pointer.line(to: NSPoint(x: 36, y: 14))
        pointer.line(to: NSPoint(x: 31, y: 25))
        pointer.line(to: NSPoint(x: 40, y: 25))
        pointer.close()
        pointer.lineJoinStyle = .round
        pointer.lineWidth = 1.5
        (isPressed ? NSColor.controlAccentColor : NSColor.white).setFill()
        NSColor.black.withAlphaComponent(0.9).setStroke()
        pointer.fill()
        pointer.stroke()
    }
}
