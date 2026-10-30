package expo.modules.orcamobilewebshell

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
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
