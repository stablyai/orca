import AppKit
import CoreGraphics
import Darwin
import OrcaComputerUseMacOSCore

enum PointerVisibility {
    private static let actionDelayMicroseconds: useconds_t = 12_000
    private static let overlay = AgentPointerOverlayController()

    static func move(to destination: CGPoint) {
        let origin = overlay.currentQuartzPoint ?? destination
        if abs(origin.x - destination.x) + abs(origin.y - destination.y) < 1 {
            overlay.move(to: destination)
            return
        }
        let plan = PointerMotionPolicy.plan(
            from: origin,
            to: destination,
            reduceMotion: overlay.shouldReduceMotion
        )
        for point in plan.points {
            overlay.move(to: point)
            if plan.delayMicroseconds > 0 {
                usleep(plan.delayMicroseconds)
            }
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
        if !overlay.shouldReduceMotion {
            usleep(actionDelayMicroseconds)
        }
    }

    static func release(at point: CGPoint) {
        overlay.setPressed(false, at: point)
        overlay.indicateAction(at: point)
    }

    static func shutdown() {
        overlay.shutdown()
    }
}

private final class AgentPointerOverlayController: @unchecked Sendable {
    private static let panelSize = CGSize(width: 64, height: 64)
    private static let hotSpot = CGPoint(x: 20, y: 44)
    private let stateLock = NSLock()
    private var quartzPoint: CGPoint?
    private var panel: NSPanel?
    private var pointerView: AgentPointerView?
    private var hideWorkItem: DispatchWorkItem?
    private var pulseResetWorkItem: DispatchWorkItem?

    var currentQuartzPoint: CGPoint? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return quartzPoint
    }

    var shouldReduceMotion: Bool {
        performOnMain {
            NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }
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
        stateLock.unlock()

        performOnMain { [self] in
            applyUIUpdate(point: point, pressed: pressed, pulse: pulse)
        }
    }

    func shutdown() {
        stateLock.lock()
        quartzPoint = nil
        stateLock.unlock()
        performOnMain { [self] in
            hideWorkItem?.cancel()
            pulseResetWorkItem?.cancel()
            hideWorkItem = nil
            pulseResetWorkItem = nil
            panel?.orderOut(nil)
            panel?.close()
            panel = nil
            pointerView = nil
        }
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
        if !panel.isVisible {
            panel.orderFrontRegardless()
        }
        schedulePulseReset(pressed: pressed)
        scheduleHide()
    }

    @MainActor
    private func ensurePanel() -> NSPanel {
        if let panel { return panel }

        let panel = AgentPointerPanel(
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
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.level = .screenSaver
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .canJoinAllApplications,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        pointerView.setAccessibilityElement(false)
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

    @MainActor
    private func schedulePulseReset(pressed: Bool) {
        pulseResetWorkItem?.cancel()
        pulseResetWorkItem = nil
        guard !pressed else { return }
        let workItem = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.pointerView?.setState(pressed: false, pulse: false)
                self?.pulseResetWorkItem = nil
            }
        }
        pulseResetWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: workItem)
    }

    @MainActor
    private func scheduleHide() {
        hideWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.panel?.orderOut(nil)
                self?.hideWorkItem = nil
            }
        }
        hideWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: workItem)
    }

    private func performOnMain<T: Sendable>(_ operation: @MainActor () -> T) -> T {
        if Thread.isMainThread {
            return MainActor.assumeIsolated(operation)
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated(operation)
        }
    }
}

private final class AgentPointerPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
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
