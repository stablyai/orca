import ExpoModulesCore
import UIKit

public class OrcaMobileWebShellModule: Module {
  private var memoryWarningObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

    // A spare is the first thing to give back: nothing is shown by it.
    OnCreate {
      memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { _ in
        MobileWebShellSparePool.shared.discardAll()
      }
    }

    OnDestroy {
      if let memoryWarningObserver {
        NotificationCenter.default.removeObserver(memoryWarningObserver)
      }
      DispatchQueue.main.async {
        MobileWebShellSparePool.shared.discardAll()
      }
    }

    OnAppEntersBackground {
      DispatchQueue.main.async {
        MobileWebShellSparePool.shared.discardAll()
      }
    }

    AsyncFunction("prepareSpare") { (hostKey: String, directory: String, sessionId: String) in
      MobileWebShellSparePool.shared.prepare(
        hostKey: hostKey,
        directory: directory,
        sessionId: sessionId
      )
    }.runOnQueue(.main)

    AsyncFunction("takeSpare") { (hostKey: String, directory: String) -> String? in
      MobileWebShellSparePool.shared.take(hostKey: hostKey, directory: directory)
    }.runOnQueue(.main)

    AsyncFunction("discardSpares") { (hostKey: String?) in
      MobileWebShellSparePool.shared.discard(hostKey: hostKey)
    }.runOnQueue(.main)

    View(OrcaMobileWebShellView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { (view: OrcaMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: OrcaMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: OrcaMobileWebShellView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: OrcaMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      AsyncFunction("replayPageReady") { (view: OrcaMobileWebShellView) in
        view.replayPageReady()
      }

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
