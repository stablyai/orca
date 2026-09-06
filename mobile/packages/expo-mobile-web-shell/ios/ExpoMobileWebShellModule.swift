import ExpoModulesCore

public final class ExpoMobileWebShellModule: Module {
  private let packageStore = sharedMobileWebPackageStore

  public func definition() -> ModuleDefinition {
    Name("ExpoMobileWebShell")

    AsyncFunction("beginStage") {
      (hostIdentity: String, manifestJson: String, canonicalManifestJson: String) -> String in
      try self.packageStore.beginStage(
        hostIdentity: hostIdentity,
        manifestJson: manifestJson,
        canonicalManifestJson: canonicalManifestJson
      )
    }

    AsyncFunction("writeAssetChunk") {
      (stageId: String, path: String, offset: Int, dataBase64: String, chunkSha256: String) in
      try self.packageStore.writeAssetChunk(
        stageId: stageId,
        path: path,
        offset: offset,
        dataBase64: dataBase64,
        chunkSha256: chunkSha256
      )
    }

    AsyncFunction("finishAsset") { (stageId: String, path: String) in
      try self.packageStore.finishAsset(stageId: stageId, path: path)
    }

    AsyncFunction("commitStage") { (stageId: String) -> [String: String] in
      ["buildId": try self.packageStore.commitStage(stageId: stageId)]
    }

    AsyncFunction("abortStage") { (stageId: String) in
      self.packageStore.abortStage(stageId: stageId)
    }

    AsyncFunction("openSession") {
      (hostIdentity: String, buildId: String?, bridgeVersion: Int) -> [String: String] in
      try self.packageStore.openSession(
        hostIdentity: hostIdentity,
        buildId: buildId,
        bridgeVersion: bridgeVersion
      )
    }

    AsyncFunction("recoverSession") { (sessionId: String) -> [String: String] in
      try self.packageStore.recoverSession(sessionId: sessionId)
    }

    AsyncFunction("markSessionHealthy") { (sessionId: String) -> [String: String] in
      ["buildId": try self.packageStore.markSessionHealthy(sessionId: sessionId)]
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
