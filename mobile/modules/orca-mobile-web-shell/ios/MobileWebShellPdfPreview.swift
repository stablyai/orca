import ExpoModulesCore
import QuickLook

/// QLPreviewController holds its data source weakly, so the module keeps the current one alive.
final class MobileWebShellPdfPreview: NSObject, QLPreviewControllerDataSource {
  private let url: URL

  init(url: URL) {
    self.url = url
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    url as NSURL
  }
}

final class PdfPresenterUnavailableException: Exception {
  override var reason: String {
    "No screen is available to present the PDF"
  }
}
