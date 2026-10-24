import Foundation
import Network

// Only the SOCKS parser stays in the reused Node fixture; both WK proxy endpoints live in-app.
// Mutable connection and startup state is confined to the listener's serial queue.
final class LoopbackRelay: @unchecked Sendable {
  let listener: NWListener
  let upstreamPort: UInt16
  let queue = DispatchQueue(label: "orca.proxy-proof.relay")
  var connections: [NWConnection] = []
  var started = false

  init(upstreamPort: UInt16) throws {
    self.upstreamPort = upstreamPort
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  func start() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { state in
        guard !self.started else { return }
        switch state {
        case .ready:
          self.started = true
          continuation.resume(returning: self.listener.port!.rawValue)
        case .failed(let error):
          self.started = true
          continuation.resume(throwing: error)
        default: break
        }
      }
      listener.newConnectionHandler = { client in
        let upstream = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: self.upstreamPort)!, using: .tcp)
        self.connections.append(contentsOf: [client, upstream])
        client.start(queue: self.queue)
        upstream.start(queue: self.queue)
        self.pipe(client, upstream)
        self.pipe(upstream, client)
      }
      listener.start(queue: queue)
    }
  }

  func pipe(_ source: NWConnection, _ destination: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
      if error != nil { source.cancel(); destination.cancel(); return }
      destination.send(content: data, isComplete: complete, completion: .contentProcessed { error in
        if complete || error != nil { source.cancel(); destination.cancel() }
        else { self.pipe(source, destination) }
      })
    }
  }

  func stop() async {
    await withCheckedContinuation { continuation in
      queue.async {
        self.listener.cancel()
        for connection in self.connections { connection.cancel() }
        self.connections.removeAll()
        continuation.resume()
      }
    }
  }
}
