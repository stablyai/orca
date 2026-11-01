import ExpoModulesCore

public class OrcaProxiedBrowserModule: Module, ProxiedBrowserSocksServerDelegate {
  private static let lock = NSLock()
  private static var servers: [String: ProxiedBrowserSocksServer] = [:]
  private static var lastConnectionId = 0
  private let queue = DispatchQueue(label: "dev.onorca.proxied-browser")
  // Touched only on `queue`.
  private var pendingStarts: [String: [Promise]] = [:]

  /// Views read this on the main thread while the proxy queue starts servers.
  static var proxies: [String: ProxiedBrowserSocksServer] {
    lock.lock()
    defer { lock.unlock() }
    return servers
  }

  public func definition() -> ModuleDefinition {
    Name("OrcaProxiedBrowser")

    Events("onProxyOpen", "onProxyData", "onProxyEnd", "onProxyClosed")

    Function("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) {
        return true
      }
      return false
    }

    // One proxy per key (each phone-drawn tab), so each web view's traffic reaches the tunnel it belongs to.
    AsyncFunction("startProxy") { (key: String, promise: Promise) in
      self.queue.async {
        if let existing = Self.proxies[key], existing.port != 0 {
          promise.resolve(Int(existing.port))
          return
        }
        // Calls that race a start in flight wait for its result instead of opening a second listener.
        if self.pendingStarts[key] != nil {
          self.pendingStarts[key]?.append(promise)
          return
        }
        self.pendingStarts[key] = [promise]
        let server = ProxiedBrowserSocksServer(proxyKey: key, queue: self.queue) {
          Self.lock.lock()
          defer { Self.lock.unlock() }
          Self.lastConnectionId += 1
          return Self.lastConnectionId
        }
        server.delegate = self
        // A listener that fails or is cancelled must not be handed out again; a later server may hold the key.
        server.onStopped = { [weak server] in
          Self.lock.lock()
          defer { Self.lock.unlock() }
          if let server, Self.servers[key] === server {
            Self.servers.removeValue(forKey: key)
          }
        }
        server.start { result in
          let waiting = self.pendingStarts.removeValue(forKey: key) ?? []
          switch result {
          case .success(let port):
            Self.lock.lock()
            Self.servers[key] = server
            Self.lock.unlock()
            waiting.forEach { $0.resolve(Int(port)) }
          case .failure(let error):
            waiting.forEach { $0.reject("proxy_start_failed", error.localizedDescription) }
          }
        }
      }
    }

    AsyncFunction("stopProxy") { (key: String) in
      self.queue.async {
        Self.lock.lock()
        let server = Self.servers.removeValue(forKey: key)
        Self.lock.unlock()
        server?.stop()
      }
    }

    Function("proxyAccept") { (connection: Int) in self.onConnection(connection) { $0.accept() } }
    Function("proxyReject") { (connection: Int) in self.onConnection(connection) { $0.reject() } }
    Function("proxyWrite") { (connection: Int, data: Data) in
      self.onConnection(connection) { $0.write(data) }
    }
    Function("proxyEnd") { (connection: Int) in self.onConnection(connection) { $0.end() } }
    Function("proxyClose") { (connection: Int) in self.onConnection(connection) { $0.close() } }

    View(OrcaProxiedBrowserView.self) {
      Events("onNavigationState")

      Prop("proxyKey") { (view: OrcaProxiedBrowserView, value: String) in view.setProxyKey(value) }
      Prop("storeId") { (view: OrcaProxiedBrowserView, value: String) in view.setStoreId(value) }
      Prop("url") { (view: OrcaProxiedBrowserView, value: String) in view.setUrl(value) }
      Prop("direct") { (view: OrcaProxiedBrowserView, value: Bool) in view.setDirect(value) }
      Prop("desktopSite") { (view: OrcaProxiedBrowserView, value: Bool) in view.setDesktopSite(value) }

      AsyncFunction("goBack") { (view: OrcaProxiedBrowserView) in view.goBack() }
      AsyncFunction("goForward") { (view: OrcaProxiedBrowserView) in view.goForward() }
      AsyncFunction("reload") { (view: OrcaProxiedBrowserView) in view.reload() }
      AsyncFunction("stopLoading") { (view: OrcaProxiedBrowserView) in view.stopLoading() }

      OnViewDidUpdateProps { (view: OrcaProxiedBrowserView) in view.propsDidUpdate() }
    }
  }

  private func onConnection(_ id: Int, _ action: @escaping (ProxiedBrowserSocksConnection) -> Void) {
    queue.async {
      for server in Self.proxies.values {
        if let connection = server.connection(id) {
          action(connection)
          return
        }
      }
    }
  }

  func socksOpen(proxy: String, connection: Int, host: String, port: Int) {
    sendEvent("onProxyOpen", ["proxy": proxy, "connection": connection, "host": host, "port": port])
  }

  // Page uploads are small; base64 keeps the event payload a plain string.
  func socksData(connection: Int, data: Data) {
    sendEvent("onProxyData", ["connection": connection, "data": data.base64EncodedString()])
  }

  func socksEnd(connection: Int) {
    sendEvent("onProxyEnd", ["connection": connection])
  }

  func socksClosed(connection: Int) {
    sendEvent("onProxyClosed", ["connection": connection])
  }
}
