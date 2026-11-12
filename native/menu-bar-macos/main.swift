import AppKit
import ImageIO
import Darwin

private let frameLimit = 256 * 1024
private let qaEnabled = CommandLine.arguments.contains("--qa")
private let writer = DispatchQueue(label: "orca.menu-bar.output")
private let outputSlots = DispatchSemaphore(value: 16)

// Nonblocking output and bounded admission keep a busy parent off the AppKit thread.
private func emit(_ value: [String: Any]) {
  guard outputSlots.wait(timeout: .now()) == .success else { _exit(1) }
  writer.async {
    defer { outputSlots.signal() }
    guard var data = try? JSONSerialization.data(withJSONObject: value), data.count < frameLimit else { _exit(1) }
    data.append(10)
    data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { _exit(1) }
        offset += count
      }
    }
  }
}

private struct ImageRepresentation: Decodable { let scale: Double; let png: String }
private struct Item: Decodable {
  let id: String?
  let label: String?
  let toolTip: String?
  let enabled: Bool?
  let type: String?
}
private struct Snapshot: Decodable {
  let images: [ImageRepresentation]
  let template: Bool
  let tooltip: String
  let menu: [Item]
}
private struct Command: Decodable {
  let type: String
  let id: Int?
  let snapshot: Snapshot?
  let operation: String?
  let action: String?
}

private final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var statusItem: NSStatusItem?
  private var sequence = 0
  private var pending: Command?
  private var tracking = false
  private let actions: Set<String> = ["open", "settings", "updates", "quit-completely", "quit"]

  func applicationDidFinishLaunching(_ notification: Notification) { emit(["type": "ready"]) }

  func accept(_ command: Command) {
    if command.type == "ping", let id = command.id, id > 0 {
      // A common-mode UI probe remains serviceable while a native menu tracks.
      RunLoop.main.perform(inModes: [.common]) { emit(["type": "pong", "id": id]) }
      CFRunLoopWakeUp(CFRunLoopGetMain())
    } else if command.type == "state", command.id != nil, command.snapshot != nil {
      RunLoop.main.perform(inModes: [.default]) {
        self.pending = command
        self.applyPending()
      }
    } else if command.type == "qa", qaEnabled {
      RunLoop.main.perform(inModes: [.default]) { self.qa(command) }
    } else { _exit(1) }
  }

  private func applyPending() {
    guard !tracking, let command = pending, let snapshot = command.snapshot, let id = command.id, id > 0 else { return }
    pending = nil
    guard snapshot.menu.count <= 16, snapshot.images.count <= 2, !snapshot.images.isEmpty else { _exit(1) }
    let image = NSImage(size: .zero)
    for representation in snapshot.images {
      guard [1.0, 2.0].contains(representation.scale),
        representation.png.utf8.count < frameLimit,
        let data = Data(base64Encoded: representation.png),
        let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
        CGImageSourceGetCount(source) == 1,
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, width <= 128, height > 0, height <= 128,
        let bitmap = NSBitmapImageRep(data: data),
        bitmap.pixelsWide == width, bitmap.pixelsHigh == height else { _exit(1) }
      bitmap.size = NSSize(width: Double(bitmap.pixelsWide) / representation.scale, height: Double(bitmap.pixelsHigh) / representation.scale)
      image.addRepresentation(bitmap)
      image.size = bitmap.size
    }
    image.isTemplate = snapshot.template
    let menu = NSMenu()
    menu.autoenablesItems = false
    menu.delegate = self
    for entry in snapshot.menu {
      if entry.type == "separator" { menu.addItem(.separator()); continue }
      let item = NSMenuItem(title: entry.label ?? "", action: entry.id == nil ? nil : #selector(selected(_:)), keyEquivalent: "")
      if let action = entry.id {
        guard actions.contains(action) else { _exit(1) }
        item.representedObject = action
        item.target = self
      }
      item.isEnabled = entry.enabled ?? (entry.id != nil)
      item.toolTip = entry.toolTip
      menu.addItem(item)
    }
    if statusItem == nil { statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength) }
    statusItem?.button?.image = image
    statusItem?.button?.toolTip = snapshot.tooltip
    statusItem?.menu = menu
    emit(["type": "applied", "id": id])
  }

  @objc private func selected(_ item: NSMenuItem) {
    guard item.isEnabled, let action = item.representedObject as? String, actions.contains(action) else { return }
    sequence += 1
    emit(["type": "action", "sequence": sequence, "action": action])
  }

  func menuWillOpen(_ menu: NSMenu) { tracking = true }
  func menuDidClose(_ menu: NSMenu) {
    tracking = false
    RunLoop.main.perform(inModes: [.default]) { self.applyPending() }
  }

  private func qa(_ command: Command) {
    guard let menu = statusItem?.menu else { emit(["type": "qa", "error": "No installed menu"]); return }
    if command.operation == "invoke", let action = command.action,
      let index = menu.items.firstIndex(where: { ($0.representedObject as? String) == action && $0.isEnabled }) {
      menu.performActionForItem(at: index)
      emit(["type": "qa", "invoked": action])
    } else if command.operation == "tracking" {
      // This proves run-loop delivery, not a displayed menu or physical click.
      tracking = true
      let source = Timer(timeInterval: 21, repeats: false) { _ in }
      RunLoop.main.add(source, forMode: .eventTracking)
      CFRunLoopRunInMode(CFRunLoopMode(rawValue: RunLoop.Mode.eventTracking.rawValue as CFString), 20, false)
      source.invalidate()
      tracking = false
      applyPending()
      emit(["type": "qa", "trackingCompleted": true])
    } else if command.operation == "inspect" {
      let image = statusItem?.button?.image
      emit(["type": "qa", "pid": getpid(), "bundleId": Bundle.main.bundleIdentifier ?? "",
        "bundlePath": Bundle.main.bundleURL.path, "template": image?.isTemplate ?? false,
        "images": image?.representations.map { ["width": $0.pixelsWide, "height": $0.pixelsHigh] } ?? [],
        "menu": menu.items.map { ["id": $0.representedObject as? String ?? "", "label": $0.title,
          "tooltip": $0.toolTip ?? "", "enabled": $0.isEnabled, "separator": $0.isSeparatorItem] as [String: Any] }])
    } else { emit(["type": "qa", "error": "Invalid QA action"]) }
  }
}

signal(SIGPIPE, SIG_IGN)
guard fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK) != -1 else { _exit(1) }
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
private let menuBar = MenuBar()
application.delegate = menuBar
DispatchQueue.global(qos: .userInitiated).async {
  var pending = Data()
  var bytes = [UInt8](repeating: 0, count: 4096)
  while true {
    let count = read(STDIN_FILENO, &bytes, bytes.count)
    if count < 0 && errno == EINTR { continue }
    // EOF cleanup does not depend on the AppKit thread or the output writer.
    guard count > 0 else { _exit(0) }
    pending.append(contentsOf: bytes.prefix(count))
    guard pending.count <= frameLimit else { _exit(1) }
    while let newline = pending.firstIndex(of: 10) {
      let frame = pending.prefix(upTo: newline)
      guard let command = try? JSONDecoder().decode(Command.self, from: frame) else { _exit(1) }
      pending.removeSubrange(...newline)
      menuBar.accept(command)
    }
  }
}
application.run()
