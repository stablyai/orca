import ExpoModulesCore
import Photos
import UIKit

/// Presents the system share sheet for one image file; its Save Image row needs NSPhotoLibraryAddUsageDescription.
func presentImageShareSheet(url: URL, from presenter: UIViewController) {
  let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
  // iPad shows the sheet as a popover, which needs an anchor; centre it with no arrow.
  if let popover = controller.popoverPresentationController {
    popover.sourceView = presenter.view
    popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
    popover.permittedArrowDirections = []
  }
  presenter.present(controller, animated: true)
}

/// Adds the file to Photos with add-only access, which never shows the user's library to Orca.
func saveImageToPhotoLibrary(url: URL, promise: Promise) {
  PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
    guard status == .authorized || status == .limited else {
      promise.reject("native_image_permission_denied", "Orca is not allowed to add to Photos")
      return
    }
    PHPhotoLibrary.shared().performChanges({
      PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: url, options: nil)
    }) { saved, error in
      if saved {
        promise.resolve(nil)
      } else {
        promise.reject("native_verb_failed", error?.localizedDescription ?? "Photos did not save the image")
      }
    }
  }
}

final class ImagePresenterUnavailableException: Exception {
  override var reason: String {
    "No screen is available to present the share sheet"
  }
}
