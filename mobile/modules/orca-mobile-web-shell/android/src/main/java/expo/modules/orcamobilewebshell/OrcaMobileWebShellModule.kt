package expo.modules.orcamobilewebshell

import android.content.ActivityNotFoundException
import android.content.ComponentCallbacks2
import android.content.Context
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
  // Kept so teardown unregisters from the same context after React has let go of it.
  private var callbacksContext: Context? = null

  // A spare is the first thing to give back: nothing is shown by it. UI_HIDDEN, above RUNNING_LOW, is
  // the app leaving the foreground; an activity pause is not, since a notification tap or deep link
  // pauses it on the way to the screen that would claim the spare.
  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) discardSpare()
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() = discardSpare()
  }

  // Callbacks and OnDestroy can run off the main thread, and the pool's WebViews must not.
  private fun discardSpare() {
    main.post { MobileWebShellSparePool.discardAll() }
  }

  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    OnCreate {
      callbacksContext = appContext.reactContext?.applicationContext?.also {
        it.registerComponentCallbacks(memoryCallbacks)
      }
    }

    OnDestroy {
      callbacksContext?.unregisterComponentCallbacks(memoryCallbacks)
      callbacksContext = null
      discardSpare()
    }

    OnActivityDestroys {
      discardSpare()
    }

    AsyncFunction("prepareSpareDocument") { directory: String, sessionId: String ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      MobileWebShellSparePool.prepare(activity, directory, sessionId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("claimSpareDocument") { directory: String ->
      MobileWebShellSparePool.claim(directory)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("discardSpareDocument") {
      MobileWebShellSparePool.discardAll()
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
