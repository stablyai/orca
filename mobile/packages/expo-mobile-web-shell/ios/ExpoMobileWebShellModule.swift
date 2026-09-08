import ExpoModulesCore

public final class ExpoMobileWebShellModule: Module {
  private let packageStore = sharedMobileWebPackageStore

  public func definition() -> ModuleDefinition {
    Name("ExpoMobileWebShell")

    AsyncFunction("writeStagedAsset") {
      (hostIdentity: String, buildId: String, path: String, dataBase64: String) in
      try self.packageStore.writeStagedAsset(
        hostIdentity: hostIdentity,
        buildId: buildId,
        path: path,
        dataBase64: dataBase64
      )
    }

    AsyncFunction("commitGeneration") {
      (hostIdentity: String, buildId: String, manifestJson: String) -> [String: String] in
      [
        "buildId": try self.packageStore.commitGeneration(
          hostIdentity: hostIdentity,
          buildId: buildId,
          manifestJson: manifestJson
        )
      ]
    }

    AsyncFunction("abortGeneration") { (hostIdentity: String, buildId: String) in
      self.packageStore.abortGeneration(hostIdentity: hostIdentity, buildId: buildId)
    }

    AsyncFunction("openSession") {
      (hostIdentity: String, buildId: String?, bridgeVersion: Int) -> [String: String] in
      try self.packageStore.openSession(
        hostIdentity: hostIdentity,
        buildId: buildId,
        bridgeVersion: bridgeVersion
      )
    }

    AsyncFunction("closeSession") { (sessionId: String) in
      self.packageStore.closeSession(sessionId: sessionId)
    }

    AsyncFunction("removeHost") { (hostIdentity: String) in
      try self.packageStore.removeHost(hostIdentity: hostIdentity)
    }

    View(MobileWebShellView.self) {
      Events("onBridgeMessage", "onNavigationBlocked", "onProcessTerminated", "onLoadState")

      Prop("sessionId") { (view, sessionId: String?) in
        view.setSessionId(sessionId)
      }

      AsyncFunction("activateSessionView") { (view: MobileWebShellView, sessionId: String) in
        view.activateSessionView(sessionId)
      }

      AsyncFunction("deactivateSessionView") { (view: MobileWebShellView) in
        view.deactivateSessionView()
      }

      AsyncFunction("postMessage") { (view, message: String) in
        try await view.postMessage(message)
      }
    }
  }
}
