import Foundation
import ExpoModulesCore
import OrcaSshEngine

public class OrcaSshTunnelModule: Module {
  private let lock = NSLock()
  private var tunnels: [String: SshtunnelTunnel] = [:]

  public func definition() -> ModuleDefinition {
    Name("OrcaSshTunnel")
    Function("create") { () throws -> String in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.tunnels.count < 16, let tunnel = SshtunnelNewTunnel() else {
        throw NSError(domain: "SSH_TUNNEL_LIMIT", code: 1)
      }
      let id = UUID().uuidString
      self.tunnels[id] = tunnel
      return id
    }
    AsyncFunction("open") { (id: String, config: String) throws -> String in
      var error: NSError?
      let result = try self.getTunnel(id).open(config, error: &error)
      if let error {
        throw error
      }
      return result
    }
    AsyncFunction("probe") { (id: String, config: String) throws -> String in
      var error: NSError?
      let result = try self.getTunnel(id).probe(config, error: &error)
      if let error {
        throw error
      }
      return result
    }
    Function("close") { (id: String) in
      self.lock.lock()
      let tunnel = self.tunnels.removeValue(forKey: id)
      self.lock.unlock()
      tunnel?.close()
    }
    OnDestroy {
      self.lock.lock()
      let active = Array(self.tunnels.values)
      self.tunnels.removeAll()
      self.lock.unlock()
      active.forEach { $0.close() }
    }
  }

  private func getTunnel(_ id: String) throws -> SshtunnelTunnel {
    lock.lock()
    defer { lock.unlock() }
    guard let tunnel = tunnels[id] else {
      throw NSError(domain: "SSH_CANCELLED", code: 1)
    }
    return tunnel
  }
}
