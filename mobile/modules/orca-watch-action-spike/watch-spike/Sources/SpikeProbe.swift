import Foundation
import Network
import UserNotifications
import WatchKit

let probeURL = URL(string: "https://relay.onorca.dev/health")!
let spikeCategory = "orca.watch-spike"
let backgroundSessionId = "orca.watchspike.bg"

// One HTTPS round trip to the Orca relay per tap, timed from the tap, with the network path recorded.
final class SpikeProbe: NSObject, URLSessionTaskDelegate, URLSessionDownloadDelegate {
  static let shared = SpikeProbe()

  private lazy var ephemeral: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    // Lets a request wake the sleeping cellular radio instead of failing as "offline" at once.
    configuration.waitsForConnectivity = true
    configuration.timeoutIntervalForResource = 25
    configuration.allowsCellularAccess = true
    configuration.allowsExpensiveNetworkAccess = true
    configuration.allowsConstrainedNetworkAccess = true
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()
  private let pathMonitor: NWPathMonitor = {
    let monitor = NWPathMonitor()
    monitor.start(queue: DispatchQueue(label: "orca.watchspike.path"))
    return monitor
  }()
  private var waitingSince: [Int: Date] = [:]
  private(set) lazy var background: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: backgroundSessionId)
    configuration.sessionSendsLaunchEvents = true
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()
  var pendingRefreshTasks: [WKURLSessionRefreshBackgroundTask] = []

  func pathSummary() -> String {
    let path = pathMonitor.currentPath
    let interfaces = path.availableInterfaces.map { "\($0.type)" }.joined(separator: ",")
    return "path=\(path.status) ifaces=[\(interfaces)] cellular=\(path.usesInterfaceType(.cellular)) "
      + "constrained=\(path.isConstrained) expensive=\(path.isExpensive)"
  }

  func runForTap(label: String, tapAt: Date, done: @escaping () -> Void) {
    SpikeLog.add("\(label) at-tap \(pathSummary())")
    let heartbeat = startHeartbeat(label: label, tapAt: tapAt)
    // Ask watchOS for extra time; the expiry callback tells us how much it actually gave.
    ProcessInfo.processInfo.performExpiringActivity(withReason: "orca-watch-spike") { expired in
      if expired {
        SpikeLog.add("\(label) expiring-activity EXPIRED at +\(millis(since: tapAt))ms")
      } else {
        SpikeLog.add("\(label) expiring-activity granted at +\(millis(since: tapAt))ms")
      }
    }

    var request = URLRequest(url: probeURL)
    request.timeoutInterval = 25
    let task = ephemeral.dataTask(with: request) { _, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let ms = millis(since: tapAt)
      if let error {
        let code = (error as NSError).code
        SpikeLog.add("\(label) fg-request FAILED +\(ms)ms code=\(code) \(error.localizedDescription) \(self.pathSummary())")
        postResult("✗ \(label) relay failed after \(ms)ms")
      } else {
        SpikeLog.add("\(label) fg-request done status=\(status) +\(ms)ms")
        postResult("✓ \(label) reached relay in \(ms)ms")
      }
      // Keep the heartbeat a little longer to see how long watchOS lets us run after the work.
      DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
        heartbeat.cancel()
        SpikeLog.add("\(label) heartbeat stopped normally at +\(millis(since: tapAt))ms")
      }
      done()
    }
    task.taskDescription = "\(label) fg"
    task.resume()
    SpikeLog.add("\(label) fg-request started +\(millis(since: tapAt))ms")

    let backgroundTask = background.downloadTask(with: probeURL)
    backgroundTask.taskDescription = "\(label) bg tapAt=\(tapAt.timeIntervalSince1970)"
    backgroundTask.resume()
    SpikeLog.add("\(label) bg-request queued")
  }

  private func startHeartbeat(label: String, tapAt: Date) -> DispatchSourceTimer {
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now(), repeating: .milliseconds(500))
    timer.setEventHandler { SpikeLog.markAlive("\(label) +\(millis(since: tapAt))ms after tap") }
    timer.resume()
    return timer
  }

  func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
    waitingSince[task.taskIdentifier] = Date()
    SpikeLog.add("\(task.taskDescription ?? "?") waiting for connectivity \(pathSummary())")
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics
  ) {
    if let since = waitingSince.removeValue(forKey: task.taskIdentifier) {
      SpikeLog.add("\(task.taskDescription ?? "?") waited \(millis(since: since))ms for network")
    }
    guard let last = metrics.transactionMetrics.last else { return }
    SpikeLog.add(
      "\(task.taskDescription ?? "?") net cellular=\(last.isCellular) expensive=\(last.isExpensive) "
        + "proto=\(last.networkProtocolName ?? "?") reused=\(last.isReusedConnection)")
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL
  ) {
    let description = downloadTask.taskDescription ?? "?"
    var delay = "?"
    if let range = description.range(of: "tapAt="),
      let tapAt = Double(description[range.upperBound...])
    {
      delay = "\(Int((Date().timeIntervalSince1970 - tapAt) * 1000))ms"
    }
    SpikeLog.add("\(description.components(separatedBy: " tapAt=").first ?? "?") done after \(delay)")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error, session === background {
      SpikeLog.add("\(task.taskDescription ?? "?") bg FAILED \(error.localizedDescription)")
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async {
      self.pendingRefreshTasks.forEach { $0.setTaskCompletedWithSnapshot(false) }
      self.pendingRefreshTasks.removeAll()
    }
  }
}

func postResult(_ text: String) {
  let content = UNMutableNotificationContent()
  content.title = "Orca watch spike"
  content.body = text
  let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  UNUserNotificationCenter.current().add(request)
}
