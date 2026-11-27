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
  // Task identifiers are only unique per session, and each session calls back on its own queue.
  private var waitingSince: [String: Date] = [:]
  private let waitingLock = NSLock()
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
    var request = URLRequest(url: probeURL)
    request.timeoutInterval = 25
    let finished = DispatchSemaphore(value: 0)
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
      finished.signal()
    }
    task.taskDescription = "\(label) fg"
    // The extra time only lasts while this block runs, so the request runs inside it until it finishes.
    // watchOS calls the block again with expired=true when time runs out; cancelling ends the wait.
    ProcessInfo.processInfo.performExpiringActivity(withReason: "orca-watch-spike") { expired in
      if expired {
        SpikeLog.add("\(label) expiring-activity EXPIRED at +\(millis(since: tapAt))ms")
        if task.state == .suspended {
          task.resume()
        } else {
          task.cancel()
        }
        return
      }
      SpikeLog.add("\(label) expiring-activity granted at +\(millis(since: tapAt))ms")
      task.resume()
      SpikeLog.add("\(label) fg-request started +\(millis(since: tapAt))ms")
      finished.wait()
      SpikeLog.add("\(label) expiring-activity released at +\(millis(since: tapAt))ms")
    }

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

  private func waitKey(_ session: URLSession, _ task: URLSessionTask) -> String {
    "\(session.configuration.identifier ?? "ephemeral")#\(task.taskIdentifier)"
  }

  func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
    waitingLock.withLock { waitingSince[waitKey(session, task)] = Date() }
    SpikeLog.add("\(task.taskDescription ?? "?") waiting for connectivity \(pathSummary())")
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics
  ) {
    let since = waitingLock.withLock { waitingSince.removeValue(forKey: waitKey(session, task)) }
    if let since {
      // The wait ends when a connection starts, not when the request finishes.
      let connected = metrics.transactionMetrics.compactMap { $0.connectStartDate ?? $0.fetchStartDate }
        .first { $0 >= since }
      let description = task.taskDescription ?? "?"
      if let connected {
        SpikeLog.add("\(description) waited \(Int(connected.timeIntervalSince(since) * 1000))ms for network")
      } else {
        SpikeLog.add("\(description) waited \(millis(since: since))ms for network and never connected")
      }
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
