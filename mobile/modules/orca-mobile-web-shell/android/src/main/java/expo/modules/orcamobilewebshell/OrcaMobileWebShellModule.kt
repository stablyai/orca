package expo.modules.orcamobilewebshell

import android.content.ActivityNotFoundException
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  private val main = Handler(Looper.getMainLooper())

  // A spare is the first thing to give back: nothing is shown by it. UI_HIDDEN, above RUNNING_LOW, is
  // the app leaving the foreground; an activity pause is not, since a notification tap or deep link
  // pauses it on the way to the screen that would claim the spare.
  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) discardAllSpares()
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() = discardAllSpares()
  }

  // Callbacks and OnDestroy can run off the main thread, and the pool's WebViews must not.
  private fun discardAllSpares() {
    main.post { MobileWebShellSparePool.discard(null) }
  }

  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    OnCreate {
      appContext.reactContext?.applicationContext?.registerComponentCallbacks(memoryCallbacks)
    }

    OnDestroy {
      appContext.reactContext?.applicationContext?.unregisterComponentCallbacks(memoryCallbacks)
      discardAllSpares()
    }

    OnActivityDestroys {
      discardAllSpares()
    }

    AsyncFunction("prepareSpareDocument") {
      buildId: String, hostKey: String, directory: String, sessionId: String, replace: Boolean ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      MobileWebShellSparePool.prepare(activity, buildId, hostKey, directory, sessionId, replace)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("claimSpareDocument") { buildId: String, hostKey: String, directory: String ->
      MobileWebShellSparePool.take(buildId, hostKey, directory)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("discardSpareDocuments") { hostKey: String? ->
      MobileWebShellSparePool.discard(hostKey)
    }.runOnQueue(Queues.MAIN)

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

    AsyncFunction("shareImage") { uri: String, mime: String ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      presentImageShareSheet(activity, Uri.parse(uri), mime)
    }

    AsyncFunction("saveImageToPhotos") { uri: String, mime: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      saveImageToGallery(context, Uri.parse(uri), mime)
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
