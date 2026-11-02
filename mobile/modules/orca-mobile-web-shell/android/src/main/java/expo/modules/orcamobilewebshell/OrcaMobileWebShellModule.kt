package expo.modules.orcamobilewebshell

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    // Takes a FileProvider content:// URI; the grant lets the chosen viewer read Orca's cache file.
    AsyncFunction("presentPdf") { uri: String ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(Uri.parse(uri), "application/pdf")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      try {
        activity.startActivity(intent)
      } catch (error: ActivityNotFoundException) {
        // The bridge forwards this code to the page as a refusal it can name.
        throw CodedException("native_pdf_no_viewer", "No installed app opens PDFs", error)
      }
    }

    // Draws a local PDF's first page onto white as a JPEG, for document tiles in chat.
    AsyncFunction("renderPdfThumbnail") { uri: String, width: Int ->
      val path = Uri.parse(uri).path ?: throw CodedException("native_pdf_unreadable", "Not a file URI", null)
      ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
          if (renderer.pageCount == 0) {
            throw CodedException("native_pdf_unreadable", "The PDF has no pages", null)
          }
          renderer.openPage(0).use { page ->
            // The page's top in the tile's 4:3 shape, at true scale: where a document shows its title.
            val bitmap = Bitmap.createBitmap(width, width * 3 / 4, Bitmap.Config.ARGB_8888)
            val scale = width.toFloat() / page.width.coerceAtLeast(1)
            try {
              bitmap.eraseColor(Color.WHITE)
              page.render(
                bitmap,
                null,
                Matrix().apply { setScale(scale, scale) },
                PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY
              )
              val jpeg = ByteArrayOutputStream()
              bitmap.compress(Bitmap.CompressFormat.JPEG, 80, jpeg)
              Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP)
            } finally {
              bitmap.recycle()
            }
          }
        }
      }
    }

    View(OrcaMobileWebShellView::class) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { view: OrcaMobileWebShellView, value: String ->
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { view: OrcaMobileWebShellView, value: String ->
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { view: OrcaMobileWebShellView, value: Boolean ->
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") { view: OrcaMobileWebShellView, json: String ->
        view.postBridgeMessage(json)
      }

      OnViewDidUpdateProps { view: OrcaMobileWebShellView ->
        view.propsDidUpdate()
      }

      OnViewDestroys { view: OrcaMobileWebShellView ->
        view.destroyWebView()
      }
    }
  }
}
