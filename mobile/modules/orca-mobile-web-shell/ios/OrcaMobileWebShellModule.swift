import ExpoModulesCore
import PDFKit
import QuickLook

public class OrcaMobileWebShellModule: Module {
  private var pdfPreview: MobileWebShellPdfPreview?

  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

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

    // Draws a local PDF's first page as a JPEG, for document tiles in chat.
    AsyncFunction("renderPdfThumbnail") { (url: URL, width: Int) -> String in
      guard let page = PDFDocument(url: url)?.page(at: 0) else {
        throw PdfThumbnailUnavailableException()
      }
      let bounds = page.bounds(for: .mediaBox)
      let height = min(CGFloat(width) * 2, CGFloat(width) * bounds.height / max(bounds.width, 1))
      let image = page.thumbnail(of: CGSize(width: CGFloat(width), height: height), for: .mediaBox)
      guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
        throw PdfThumbnailUnavailableException()
      }
      return jpeg.base64EncodedString()
    }

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

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
