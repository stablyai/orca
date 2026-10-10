import Foundation
// IrohLib.swift is compiled into this same ExpoIroh target (vendored bindings).

/// Owns the local Endpoint and live dialed connections (one bi-stream each).
/// Framing: 4-byte big-endian u32 length + payload; max 1 MiB.
final class IrohClient {
  static let shared = IrohClient()
  static let alpn = Data("orca-mobile-rpc/1".utf8)
  static let maxFrame = 1 * 1024 * 1024
  static let pathPollNanos: UInt64 = 2_000_000_000

  var onMessage: ((String, String) -> Void)?
  var onPathChanged: ((String, String, String) -> Void)?
  var onClosed: ((String, String) -> Void)?

  private let lock = NSLock()
  private var startTask: Task<Endpoint, Error>?
  private var endpoint: Endpoint?
  private var connections: [String: LiveConnection] = [:]
  // Why: stop() during an in-flight bind must not let the late bind result
  // resurrect state — stale generations close their endpoint instead.
  private var generation = 0

  private init() {}

  func start() async throws -> String {
    try await ensureEndpoint().id().description
  }

  func connect(endpointId: String, relayUrl: String?, directAddresses: [String]) async throws -> String {
    let ep = try await ensureEndpoint()
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
    locked { connections[connectionId] = live }
    startReadLoop(live)
    startPathPoll(live)
    startClosedWatch(live)
    return connectionId
  }

  func send(connectionId: String, bytesBase64: String) async throws {
    guard let live = locked({ connections[connectionId] }) else {
      throw IrohClientError.unknownConnection
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
      try await live.send.writeAll(buf: frame)
      await live.writeLock.release()
    } catch {
      await live.writeLock.release()
      throw error
    }
  }

  func pathInfo(connectionId: String) throws -> (pathType: String, detail: String) {
    guard let live = locked({ connections[connectionId] }) else {
      throw IrohClientError.unknownConnection
    }
    return IrohPathUtils.snapshot(live.connection.paths())
  }

  func close(connectionId: String) async {
    let live = locked { connections.removeValue(forKey: connectionId) }
    guard let live else { return }
    await teardown(live, reason: "closed", emit: true)
  }

  func stop() async {
    let (lives, ep) = locked { () -> ([LiveConnection], Endpoint?) in
      generation += 1
      let all = Array(connections.values)
      connections.removeAll()
      let current = endpoint
      endpoint = nil
      startTask = nil
      return (all, current)
    }
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

  private func ensureEndpoint() async throws -> Endpoint {
    // Why: concurrent dials share one bind task — a check-then-bind race would
    // leak the losing endpoint's UDP socket and hand JS a dead endpoint id.
    let (task, gen) = locked { () -> (Task<Endpoint, Error>, Int) in
      if let existing = startTask { return (existing, generation) }
      let created = Task {
        let ep = try await Endpoint.bind(options: EndpointOptions(
          preset: presetN0(),
          alpns: [Self.alpn]
        ))
        await ep.online()
        return ep
      }
      startTask = created
      return (created, generation)
    }
    do {
      let ep = try await task.value
      let stale = locked { generation != gen }
      if stale {
        try? await ep.close()
        throw IrohClientError.notStarted
      }
      locked { endpoint = ep }
      return ep
    } catch {
      locked { if generation == gen { startTask = nil } }
      throw error
    }
  }

  private func startReadLoop(_ live: LiveConnection) {
    live.readTask = Task { [weak self] in
      guard let self else { return }
      var buffer = Data()
      do {
        while !Task.isCancelled {
          let chunk = try await live.recv.read(sizeLimit: UInt32(64 * 1024))
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

  private func drainFrames(from buffer: inout Data, connectionId: String) throws {
    while buffer.count >= 4 {
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
      onMessage?(connectionId, payload.base64EncodedString())
    }
  }

  private func startPathPoll(_ live: LiveConnection) {
    live.pathTask = Task { [weak self] in
      while !Task.isCancelled {
        let snap = IrohPathUtils.snapshot(live.connection.paths())
        if snap.pathType != live.lastPathType || snap.detail != live.lastPathDetail {
          live.lastPathType = snap.pathType
          live.lastPathDetail = snap.detail
          self?.onPathChanged?(live.id, snap.pathType, snap.detail)
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

  private func drop(connectionId: String, reason: String) async {
    let live = locked { connections.removeValue(forKey: connectionId) }
    guard let live else { return }
    await teardown(live, reason: reason, emit: true)
  }

  private func teardown(_ live: LiveConnection, reason: String, emit: Bool) async {
    live.readTask?.cancel()
    live.pathTask?.cancel()
    live.closedTask?.cancel()
    try? live.connection.close(errorCode: 0, reason: Data(reason.utf8))
    if emit {
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
  case unknownConnection
  case invalidBase64
  case frameTooLarge

  var errorDescription: String? {
    switch self {
    case .notStarted: return "iroh_not_started"
    case .invalidEndpointId: return "iroh_invalid_endpoint_id"
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

  func acquire() async {
    if busy {
      await withCheckedContinuation { waiters.append($0) }
    } else {
      busy = true
    }
  }

  func release() {
    if waiters.isEmpty {
      busy = false
    } else {
      waiters.removeFirst().resume()
    }
  }
}
