package expo.modules.orcamobilewebshell

import android.content.ActivityNotFoundException
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

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

    Function("supportsVisualDocuments") { true }

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

    // Page builds live in filesDir: "Clear cache", cleaner apps and low storage empty cacheDir, which cost a full
    // download on the next open. allowBackup false and the device-transfer rules keep them on this phone.
    Function("generationStoreDirectory") { name: String ->
      val filesDir = appContext.reactContext?.filesDir ?: throw Exceptions.ReactContextLost()
      val directory = File(filesDir, name)
      // A full disk can refuse the folder; the caller then keeps the old root.
      if (!directory.mkdirs() && !directory.isDirectory) throw UnableToCreateGenerationStoreException()
      Uri.fromFile(directory).toString()
    }

    // Lets isolation-unavailable name the WebView to update.
    Function("currentWebViewProvider") {
      val context = appContext.reactContext ?: return@Function null
      val info = WebViewCompat.getCurrentWebViewPackage(context) ?: return@Function null
      val version = info.versionName ?: return@Function null
      val name = info.applicationInfo?.loadLabel(context.packageManager)?.toString() ?: info.packageName
      val hasShellFeatures = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
      mapOf("name" to name, "version" to version, "hasShellFeatures" to hasShellFeatures)
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

      AsyncFunction("createVisualDocument") { view: OrcaMobileWebShellView, html: String ->
        view.createVisualDocument(html)
      }

      AsyncFunction("releaseVisualDocument") { view: OrcaMobileWebShellView, url: String ->
        view.releaseVisualDocument(url)
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

private class UnableToCreateGenerationStoreException :
  CodedException("The page build folder could not be created")
