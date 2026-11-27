import Foundation

// Survives suspension and relaunch, so a timeline gap shows where watchOS stopped the app.
enum SpikeLog {
  private static let key = "orca.watchspike.events"
  private static let lastAliveKey = "orca.watchspike.lastAlive"
  private static let lock = NSLock()
  private static let formatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter
  }()

  static func add(_ line: String) {
    lock.lock(); defer { lock.unlock() }
    var lines = UserDefaults.standard.stringArray(forKey: key) ?? []
    lines.append("\(formatter.string(from: Date())) \(line)")
    UserDefaults.standard.set(Array(lines.suffix(80)), forKey: key)
  }

  static func all() -> [String] {
    UserDefaults.standard.stringArray(forKey: key) ?? []
  }

  static func markAlive(_ label: String) {
    UserDefaults.standard.set("\(formatter.string(from: Date())) \(label)", forKey: lastAliveKey)
  }

  static func lastAlive() -> String {
    UserDefaults.standard.string(forKey: lastAliveKey) ?? "-"
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: key)
    UserDefaults.standard.removeObject(forKey: lastAliveKey)
  }
}

func millis(since start: Date) -> Int {
  Int(Date().timeIntervalSince(start) * 1000)
}
