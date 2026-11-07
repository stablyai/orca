import Foundation
// IrohLib.swift is compiled into this same ExpoIroh target (vendored bindings).

/// Owns the local Endpoint and live dialed connections (one bi-stream each).
/// Framing: 4-byte big-endian u32 length + bounded raw payload.
final class IrohClient {
  static let alpn = Data("orca-mobile-rpc/1".utf8)
  // max(base64(4 MiB + 82), 8 MiB + 82); E2EEv2 adds 24 nonce + 16 MAC + 42 header bytes.
  static let maxFrame = 8 * 1024 * 1024 + 82
  static let pathPollNanos: UInt64 = 2_000_000_000

  var onMessage: ((String, String) -> Void)?
  var onPathChanged: ((String, String, String) -> Void)?
  var onClosed: ((String, String) -> Void)?

  private let lock = NSLock()
  private let stopLock = AsyncLock()
  private var startTask: Task<Endpoint, Error>?
  private var endpoint: Endpoint?
  private var homeRelayUrl: String?
  private var connections: [String: LiveConnection] = [:]
  // Why: stop() during an in-flight bind must not let the late bind result
  // resurrect state — stale generations close their endpoint instead.
  private var generation = 0
  private var destroyed = false

  init() {}

  /// Bind the local endpoint, retiring the previous one if its home relay changes.
  func start(homeRelayUrl: String?) async throws -> String {
    try Task.checkCancellation()
    let selected = try Self.parseHomeRelayUrl(homeRelayUrl)
    await stopLock.acquire()
    let changed: Bool
    do {
      try Task.checkCancellation()
      changed = try locked {
        guard !destroyed else { throw IrohClientError.notStarted }
        let changed = self.homeRelayUrl != selected
        self.homeRelayUrl = selected
        return changed
      }
    } catch {
      await stopLock.release()
      throw error
    }
    if changed { await stopLocked() }
    let startGeneration = locked { generation }
    await stopLock.release()
    try Task.checkCancellation()
    let (ep, gen) = try await ensureEndpoint(expectedGeneration: startGeneration)
    try Task.checkCancellation()
    return try locked {
      guard !destroyed, generation == gen, endpoint === ep else { throw IrohClientError.notStarted }
      return ep.id().description
    }
  }

  /// Dial a peer with address hints and publish one bi-stream plus its lifecycle tasks.
  func connect(endpointId: String, relayUrl: String?, directAddresses: [String]) async throws -> String {
    try Task.checkCancellation()
    let connectGeneration = locked { generation }
    let (ep, gen) = try await ensureEndpoint(expectedGeneration: connectGeneration)
    try Task.checkCancellation()
    let trimmed = endpointId
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    guard trimmed.count == 64, trimmed.allSatisfy(\.isHexDigit) else {
      throw IrohClientError.invalidEndpointId
    }
    let remoteId = try EndpointId.fromString(s: trimmed)
    // Why: pairing-supplied dial hints let same-LAN peers connect without the
    // n0 discovery service (offline LAN) and shave the discovery round-trip.
    let addr = EndpointAddr(id: remoteId, relayUrl: relayUrl, addresses: directAddresses)
    let conn = try await ep.connect(addr: addr, alpn: Self.alpn)
    let bi: BiStream
    do {
      try Task.checkCancellation()
      guard locked({ !destroyed && generation == gen && endpoint === ep }) else {
        throw IrohClientError.notStarted
      }
      bi = try await conn.openBi()
    } catch {
      try? conn.close(errorCode: 0, reason: Data("open_bi_failed".utf8))
      throw error
    }
    let connectionId = UUID().uuidString.lowercased()
    let live = LiveConnection(
      id: connectionId,
      connection: conn,
      send: bi.send(),
      recv: bi.recv()
    )
    let current = locked { () -> Bool in
      guard !destroyed, generation == gen, endpoint === ep, !Task.isCancelled else { return false }
      connections[connectionId] = live
      // Publish all task handles before stop can take ownership of this connection.
      startReadLoop(live)
      startPathPoll(live)
      startClosedWatch(live)
      return true
    }
    guard current else {
      await teardown(live, reason: "stopped", emit: false)
      throw IrohClientError.notStarted
    }
    do {
      try Task.checkCancellation()
      return connectionId
    } catch {
      await drop(connectionId: connectionId, reason: "closed")
      throw error
    }
  }

  /// Decode bridge base64 before applying the raw wire cap and serializing the framed write.
  func send(connectionId: String, bytesBase64: String) async throws {
    guard let live = locked({ destroyed ? nil : connections[connectionId] }) else {
      throw IrohClientError.unknownConnection
    }
    guard bytesBase64.utf8.count <= ((Self.maxFrame + 2) / 3) * 4 else {
      throw IrohClientError.frameTooLarge
    }
    guard let payload = Data(base64Encoded: bytesBase64) else {
      throw IrohClientError.invalidBase64
    }
    guard payload.count <= Self.maxFrame else {
      throw IrohClientError.frameTooLarge
    }
    // Why: header+payload go out as ONE writeAll under a FIFO lock — JS sends
    // are fire-and-forget, so two in-flight frames must never interleave bytes
    // on the shared stream.
    var frame = Data(count: 4)
    let len = UInt32(payload.count).bigEndian
    frame.withUnsafeMutableBytes { raw in
      raw.storeBytes(of: len, as: UInt32.self)
    }
    frame.append(payload)
    await live.writeLock.acquire()
    do {
      try Task.checkCancellation()
      try await live.send.writeAll(buf: frame)
      await live.writeLock.release()
    } catch {
      await live.writeLock.release()
      throw error
    }
  }

  func pathInfo(connectionId: String) throws -> (pathType: String, detail: String) {
    guard let live = locked({ destroyed ? nil : connections[connectionId] }) else {
      throw IrohClientError.unknownConnection
    }
    return IrohPathUtils.snapshot(live.connection.paths())
  }

  /// Remove and close a connection once; unknown connection IDs are ignored.
  func close(connectionId: String) async {
    let live = locked { connections.removeValue(forKey: connectionId) }
    guard let live else { return }
    await teardown(live, reason: "closed", emit: true)
  }

  func stop() async {
    await stopLock.acquire()
    await stopLocked()
    await stopLock.release()
  }

  /// Permanently reject new work and schedule endpoint and connection cleanup once.
  func destroy() {
    let shouldStop = locked { () -> Bool in
      guard !destroyed else { return false }
      destroyed = true
      return true
    }
    if shouldStop {
      Task { await self.stop() }
    }
  }

  /// Retire state while holding stopLock, consume any bind result, and close the retired resources.
  private func stopLocked() async {
    let (lives, ep, task) = locked { () -> ([LiveConnection], Endpoint?, Task<Endpoint, Error>?) in
      generation += 1
      let all = Array(connections.values)
      connections.removeAll()
      let current = endpoint
      endpoint = nil
      let task = startTask
      startTask = nil
      return (all, current, task)
    }
    // Bind is local, not a relay-online wait. Join so its owned result is always consumed.
    _ = await task?.result
    for live in lives {
      await teardown(live, reason: "stopped", emit: true)
    }
    try? await ep?.close()
  }

  // MARK: - private

  private func locked<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  /// Normalize an HTTPS relay origin; blank selects the preset, while non-root URLs are rejected.
  static func parseHomeRelayUrl(_ value: String?) throws -> String? {
    guard let selected = value?.trimmingCharacters(in: .whitespacesAndNewlines),
      !selected.isEmpty else { return nil }
    guard selected.range(of: #"^https://[^/?#@\\\s]+/?$"#,
      options: [.regularExpression, .caseInsensitive]) != nil,
      !selected.hasSuffix(":"), !selected.hasSuffix(":/"), !selected.contains("%"),
      var components = URLComponents(string: selected),
      components.scheme?.lowercased() == "https",
      let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil,
      components.path.isEmpty || components.path == "/",
      (1...65535).contains(components.port ?? 443)
    else { throw IrohClientError.invalidRelayUrl }
    components.scheme = "https"
    components.host = host.lowercased()
    if components.port == 443 { components.port = nil }
    components.path = "/"
    guard let canonical = components.url?.absoluteString else {
      throw IrohClientError.invalidRelayUrl
    }
    return canonical
  }

  /// Share one bind for this generation; only its task publishes or closes the owned endpoint.
  private func ensureEndpoint(expectedGeneration: Int) async throws -> (Endpoint, Int) {
    let (task, gen) = try locked { () -> (Task<Endpoint, Error>, Int) in
      guard !destroyed, generation == expectedGeneration else { throw IrohClientError.notStarted }
      if let existing = startTask { return (existing, expectedGeneration) }
      let gen = expectedGeneration
      let selected = homeRelayUrl
      let created = Task {
        let relayMode: RelayMode?
        if let selected {
          do {
            relayMode = try RelayMode.customFromUrls(urls: [selected])
          } catch {
            throw IrohClientError.invalidRelayUrl
          }
        } else {
          relayMode = nil
        }
        let ep = try await Endpoint.bind(options: EndpointOptions(
          preset: presetN0(),
          alpns: [Self.alpn],
          relayMode: relayMode
        ))
        let current = self.locked { () -> Bool in
          guard !self.destroyed, self.generation == gen else { return false }
          self.endpoint = ep
          return true
        }
        guard current else {
          try? await ep.close()
          throw IrohClientError.notStarted
        }
        return ep
      }
      startTask = created
      return (created, gen)
    }
    do {
      let ep = try await task.value
      guard locked({ !destroyed && generation == gen && endpoint === ep }) else {
        throw IrohClientError.notStarted
      }
      return (ep, gen)
    } catch {
      locked { if generation == gen && startTask == task { startTask = nil } }
      throw error
    }
  }

  /// Buffer stream chunks into frames, dropping the connection on EOF or a non-cancellation failure.
  private func startReadLoop(_ live: LiveConnection) {
    live.readTask = Task { [weak self] in
      guard let self else { return }
      var buffer = Data()
      do {
        while !Task.isCancelled {
          let chunk = try await live.recv.read(sizeLimit: UInt32(64 * 1024))
          try Task.checkCancellation()
          if chunk.isEmpty { break }
          buffer.append(chunk)
          try self.drainFrames(from: &buffer, connectionId: live.id)
        }
        await self.drop(connectionId: live.id, reason: "stream_ended")
      } catch {
        if !Task.isCancelled {
          await self.drop(connectionId: live.id, reason: String(describing: error))
        }
      }
    }
  }

  /// Emit complete bounded frames as base64, retaining an incomplete frame for the next read.
  private func drainFrames(from buffer: inout Data, connectionId: String) throws {
    while buffer.count >= 4 {
      try Task.checkCancellation()
      let length: UInt32 = buffer.prefix(4).withUnsafeBytes { raw in
        raw.loadUnaligned(as: UInt32.self).bigEndian
      }
      let frameLen = Int(length)
      guard frameLen <= Self.maxFrame else {
        throw IrohClientError.frameTooLarge
      }
      guard buffer.count >= 4 + frameLen else { return }
      let payload = buffer.subdata(in: 4..<(4 + frameLen))
      buffer.removeSubrange(0..<(4 + frameLen))
      if locked({ !destroyed && connections[connectionId] != nil }) {
        onMessage?(connectionId, payload.base64EncodedString())
      }
    }
  }

  /// Poll live paths every two seconds and emit only changes to the type or route details.
  private func startPathPoll(_ live: LiveConnection) {
    live.pathTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.locked({ !self.destroyed && self.connections[live.id] === live }) else {
          return
        }
        let snap = IrohPathUtils.snapshot(live.connection.paths())
        if snap.pathType != live.lastPathType || snap.detail != live.lastPathDetail {
          live.lastPathType = snap.pathType
          live.lastPathDetail = snap.detail
          self.onPathChanged?(live.id, snap.pathType, snap.detail)
        }
        try? await Task.sleep(nanoseconds: Self.pathPollNanos)
      }
    }
  }

  private func startClosedWatch(_ live: LiveConnection) {
    live.closedTask = Task { [weak self] in
      let reason = await live.connection.closed()
      await self?.drop(connectionId: live.id, reason: reason.isEmpty ? "closed" : reason)
    }
  }

  /// Remove a connection once and preserve the peer's close reason when receive failure wins the race.
  private func drop(connectionId: String, reason: String) async {
    let live = locked { connections.removeValue(forKey: connectionId) }
    guard let live else { return }
    await teardown(live, reason: live.connection.closeReason() ?? reason, emit: true)
  }

  /// Cancel lifecycle tasks, close the stream's connection, and optionally notify while not destroyed.
  private func teardown(_ live: LiveConnection, reason: String, emit: Bool) async {
    live.readTask?.cancel()
    live.pathTask?.cancel()
    live.closedTask?.cancel()
    try? live.connection.close(errorCode: 0, reason: Data(reason.utf8))
    if emit && locked({ !destroyed }) {
      onClosed?(live.id, reason)
    }
  }
}

// MARK: - types

private final class LiveConnection {
  let id: String
  let connection: Connection
  let send: SendStream
  let recv: RecvStream
  let writeLock = AsyncLock()
  var lastPathType = ""
  var lastPathDetail = ""
  var readTask: Task<Void, Never>?
  var pathTask: Task<Void, Never>?
  var closedTask: Task<Void, Never>?

  init(id: String, connection: Connection, send: SendStream, recv: RecvStream) {
    self.id = id
    self.connection = connection
    self.send = send
    self.recv = recv
  }
}

enum IrohClientError: Error, LocalizedError {
  case notStarted
  case invalidEndpointId
  case invalidRelayUrl
  case unknownConnection
  case invalidBase64
  case frameTooLarge

  var errorDescription: String? {
    switch self {
    case .notStarted: return "iroh_not_started"
    case .invalidEndpointId: return "iroh_invalid_endpoint_id"
    case .invalidRelayUrl: return "iroh_invalid_relay_url"
    case .unknownConnection: return "iroh_unknown_connection"
    case .invalidBase64: return "iroh_invalid_base64"
    case .frameTooLarge: return "iroh_frame_too_large"
    }
  }
}

/// FIFO async mutex. Actors are reentrant, so plain actor isolation does NOT
/// serialize suspending work — ownership must be tracked explicitly.
actor AsyncLock {
  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  /// Wait for FIFO ownership across suspension; every acquisition must eventually be released.
  func acquire() async {
    if busy {
      await withCheckedContinuation { waiters.append($0) }
    } else {
      busy = true
    }
  }

  /// Transfer ownership to the oldest waiter, or mark the lock idle when none remain.
  func release() {
    if waiters.isEmpty {
      busy = false
    } else {
      waiters.removeFirst().resume()
    }
  }
}
