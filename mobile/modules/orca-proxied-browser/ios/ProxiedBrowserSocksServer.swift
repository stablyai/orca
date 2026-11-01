import Foundation
import Network

/// What the server tells JS; JS answers through the server's accept/write/end/close.
protocol ProxiedBrowserSocksServerDelegate: AnyObject {
  func socksOpen(proxy: String, connection: Int, host: String, port: Int)
  func socksData(connection: Int, data: Data)
  func socksEnd(connection: Int)
  func socksClosed(connection: Int)
}

/// A loopback SOCKS5 listener for one host's web views. A per-launch credential keeps other apps out.
final class ProxiedBrowserSocksServer {
  let proxyKey: String
  let username = ProxiedBrowserSocksServer.randomToken()
  let password = ProxiedBrowserSocksServer.randomToken()
  private(set) var port: UInt16 = 0

  private let queue: DispatchQueue
  private var listener: NWListener?
  private var connections: [Int: ProxiedBrowserSocksConnection] = [:]
  private let nextConnectionId: () -> Int
  weak var delegate: ProxiedBrowserSocksServerDelegate?
  // Called once when the listener stops for any reason, so the registry drops this server.
  var onStopped: (() -> Void)?
  private var stopped = false

  init(proxyKey: String, queue: DispatchQueue, nextConnectionId: @escaping () -> Int) {
    self.proxyKey = proxyKey
    self.queue = queue
    self.nextConnectionId = nextConnectionId
  }

  func start(completion: @escaping (Result<UInt16, Error>) -> Void) {
    do {
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
      let listener = try NWListener(using: parameters)
      self.listener = listener
      var settled = false
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          self.port = listener.port?.rawValue ?? 0
          if !settled {
            settled = true
            completion(.success(self.port))
          }
        case .failed(let error):
          self.stop()
          if !settled {
            settled = true
            completion(.failure(error))
          }
        case .cancelled:
          self.stop()
          if !settled {
            settled = true
            completion(.failure(CancellationError()))
          }
        default:
          break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        self?.adopt(connection)
      }
      listener.start(queue: queue)
    } catch {
      completion(.failure(error))
    }
  }

  func stop() {
    guard !stopped else { return }
    stopped = true
    port = 0
    listener?.cancel()
    listener = nil
    for connection in connections.values {
      connection.close()
    }
    connections.removeAll()
    onStopped?()
    onStopped = nil
  }

  func connection(_ id: Int) -> ProxiedBrowserSocksConnection? {
    connections[id]
  }

  private func adopt(_ nwConnection: NWConnection) {
    let id = nextConnectionId()
    let connection = ProxiedBrowserSocksConnection(
      id: id,
      connection: nwConnection,
      queue: queue,
      handshake: ProxiedBrowserSocksRequest(
        username: Data(username.utf8), password: Data(password.utf8))
    )
    connection.onConnect = { [weak self] host, port in
      guard let self else { return }
      self.delegate?.socksOpen(proxy: self.proxyKey, connection: id, host: host, port: port)
    }
    connection.onData = { [weak self] data in self?.delegate?.socksData(connection: id, data: data) }
    connection.onEnd = { [weak self] in self?.delegate?.socksEnd(connection: id) }
    connection.onClosed = { [weak self] in
      guard let self, self.connections.removeValue(forKey: id) != nil else { return }
      self.delegate?.socksClosed(connection: id)
    }
    connections[id] = connection
    connection.start()
  }

  private static func randomToken() -> String {
    var bytes = [UInt8](repeating: 0, count: 24)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    precondition(status == errSecSuccess, "no system randomness for the proxy credential")
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}

/// One web view connection: the SOCKS handshake, then raw bytes both ways.
final class ProxiedBrowserSocksConnection {
  let id: Int
  private let connection: NWConnection
  private let queue: DispatchQueue
  private var handshake: ProxiedBrowserSocksRequest
  private var buffer = Data()
  private var tunneling = false
  private var closed = false

  var onConnect: ((String, Int) -> Void)?
  var onData: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var onClosed: (() -> Void)?

  init(id: Int, connection: NWConnection, queue: DispatchQueue, handshake: ProxiedBrowserSocksRequest) {
    self.id = id
    self.connection = connection
    self.queue = queue
    self.handshake = handshake
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.finish()
      default:
        break
      }
    }
    connection.start(queue: queue)
    receive()
  }

  /// The host reached the destination; page bytes flow from here on.
  func accept() {
    guard !closed, !tunneling else { return }
    tunneling = true
    send(ProxiedBrowserSocksRequest.successReply)
    if !buffer.isEmpty {
      let early = buffer
      buffer.removeAll()
      onData?(early)
    }
  }

  func reject() {
    guard !closed else { return }
    connection.send(
      content: ProxiedBrowserSocksRequest.failureReply(5),
      completion: .contentProcessed { [weak self] _ in self?.close() })
  }

  func write(_ data: Data) {
    guard !closed, tunneling else { return }
    send(data)
  }

  /// The destination finished sending; tell the web view with a FIN.
  func end() {
    guard !closed else { return }
    connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
  }

  func close() {
    guard !closed else { return }
    connection.cancel()
    finish()
  }

  private func send(_ data: Data) {
    connection.send(
      content: data,
      completion: .contentProcessed { [weak self] error in
        if error != nil {
          self?.close()
        }
      })
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self, !self.closed else { return }
      if let data, !data.isEmpty {
        self.handle(data)
      }
      if isComplete {
        if self.tunneling {
          self.onEnd?()
        } else {
          self.close()
        }
        return
      }
      if error != nil {
        self.close()
        return
      }
      self.receive()
    }
  }

  private func handle(_ data: Data) {
    if tunneling {
      onData?(data)
      return
    }
    buffer.append(data)
    while !tunneling && !closed {
      let (step, consumed) = handshake.advance(buffer)
      buffer.removeFirst(consumed)
      switch step {
      case .needMore:
        return
      case .reply(let reply):
        send(reply)
      case .connect(let host, let port):
        onConnect?(host, port)
        return
      case .fail(let reply):
        if let reply {
          connection.send(content: reply, completion: .contentProcessed { [weak self] _ in self?.close() })
        } else {
          close()
        }
        return
      }
    }
  }

  private func finish() {
    guard !closed else { return }
    closed = true
    onClosed?()
  }
}
