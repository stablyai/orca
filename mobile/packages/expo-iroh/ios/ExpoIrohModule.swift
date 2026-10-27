import ExpoModulesCore

private let ON_MESSAGE = "onMessage"
private let ON_PATH_CHANGED = "onPathChanged"
private let ON_CLOSED = "onClosed"

public class ExpoIrohModule: Module {
  private let client = IrohClient.shared
  private var wired = false

  public func definition() -> ModuleDefinition {
    Name("ExpoIroh")

    Events([ON_MESSAGE, ON_PATH_CHANGED, ON_CLOSED])

    OnCreate {
      self.wireCallbacks()
    }

    AsyncFunction("irohStart") { () -> [String: String] in
      let endpointId = try await self.client.start()
      return ["endpointId": endpointId]
    }

    AsyncFunction("irohConnect") {
      (endpointId: String, relayUrl: String?, directAddresses: [String]?) -> [String: String] in
      let connectionId = try await self.client.connect(
        endpointId: endpointId,
        relayUrl: relayUrl,
        directAddresses: directAddresses ?? []
      )
      return ["connectionId": connectionId]
    }

    AsyncFunction("irohSend") { (connectionId: String, bytesBase64: String) in
      try await self.client.send(connectionId: connectionId, bytesBase64: bytesBase64)
    }

    AsyncFunction("irohPathInfo") { (connectionId: String) -> [String: String] in
      let info = try self.client.pathInfo(connectionId: connectionId)
      return ["pathType": info.pathType, "detail": info.detail]
    }

    AsyncFunction("irohClose") { (connectionId: String) in
      await self.client.close(connectionId: connectionId)
    }

    AsyncFunction("irohStop") {
      await self.client.stop()
    }
  }

  private func wireCallbacks() {
    guard !wired else { return }
    wired = true
    client.onMessage = { [weak self] connectionId, bytesBase64 in
      self?.sendEvent(ON_MESSAGE, [
        "connectionId": connectionId,
        "bytesBase64": bytesBase64
      ])
    }
    client.onPathChanged = { [weak self] connectionId, pathType, detail in
      self?.sendEvent(ON_PATH_CHANGED, [
        "connectionId": connectionId,
        "pathType": pathType,
        "detail": detail
      ])
    }
    client.onClosed = { [weak self] connectionId, reason in
      self?.sendEvent(ON_CLOSED, [
        "connectionId": connectionId,
        "reason": reason
      ])
    }
  }
}
