import ExpoModulesCore
import QuickLook
import UIKit

public class OrcaMobileWebShellModule: Module {
  private var pdfPreview: MobileWebShellPdfPreview?
  private var memoryWarningObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

    OnCreate {
      DispatchQueue.main.async {
        // Compile before the first shell view asks, so its load does not wait on the rule store.
        NetworkBlockRuleList.load { _ in }
      }
      // A spare is the first thing to give back: nothing is shown by it.
      memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { _ in
        MobileWebShellSparePool.shared.discard(hostKey: nil)
      }
    }

    OnDestroy {
      if let memoryWarningObserver {
        NotificationCenter.default.removeObserver(memoryWarningObserver)
      }
      DispatchQueue.main.async {
        MobileWebShellSparePool.shared.discard(hostKey: nil)
      }
    }

    // Never keep a spare in the background; the shell boots another after the next foreground idle.
    OnAppEntersBackground {
      DispatchQueue.main.async {
        MobileWebShellSparePool.shared.discard(hostKey: nil)
      }
    }

    AsyncFunction("presentPdf") { (url: URL) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw PdfPresenterUnavailableException()
      }
      let preview = MobileWebShellPdfPreview(url: url)
      let controller = QLPreviewController()
      controller.dataSource = preview
      self.pdfPreview = preview
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)

    AsyncFunction("shareImage") { (url: URL, _: String) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw ImagePresenterUnavailableException()
      }
      presentImageShareSheet(url: url, from: presenter)
    }.runOnQueue(.main)

    AsyncFunction("saveImageToPhotos") { (url: URL, _: String, promise: Promise) in
      saveImageToPhotoLibrary(url: url, promise: promise)
    }

    AsyncFunction("prepareSpareDocument") {
      (buildId: String, hostKey: String, directory: String, sessionId: String, replace: Bool)
        -> Bool in
      MobileWebShellSparePool.shared.prepare(
        buildId: buildId,
        hostKey: hostKey,
        directory: directory,
        sessionId: sessionId,
        replace: replace
      )
    }.runOnQueue(.main)

    AsyncFunction("claimSpareDocument") {
      (buildId: String, hostKey: String, directory: String) -> String? in
      MobileWebShellSparePool.shared.take(buildId: buildId, hostKey: hostKey, directory: directory)
    }.runOnQueue(.main)

    AsyncFunction("discardSpareDocuments") { (hostKey: String?) in
      MobileWebShellSparePool.shared.discard(hostKey: hostKey)
    }.runOnQueue(.main)

    View(OrcaMobileWebShellView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation", "onBackEdgeSwipe")

      Prop("generationDirectory") { (view: OrcaMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: OrcaMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: OrcaMobileWebShellView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      Prop("backEdgeSwipe") { (view: OrcaMobileWebShellView, value: Bool) in
        view.setBackEdgeSwipe(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: OrcaMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
