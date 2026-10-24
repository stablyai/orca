package expo.modules.orcaappupdater

import android.content.ClipData
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.InterruptedIOException
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

class UpdateAsset : Record {
  @Field val version: String = ""
  @Field val url: String = ""
  @Field val size: Long = 0
  @Field val sha256: String = ""

  fun validate() {
    require(version.matches(Regex("\\d+\\.\\d+\\.\\d+"))) { "Invalid update version." }
    require(url == "https://github.com/stablyai/orca/releases/download/mobile-android-v$version/app-release.apk") {
      "Only Orca's GitHub release APKs can be installed."
    }
    require(size in 1..MAX_APK_BYTES && sha256.matches(Regex("[a-f0-9]{64}"))) {
      "The release has no valid APK checksum or size."
    }
  }
}

class OrcaAppUpdaterModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  @Volatile private var call: Call? = null
  @Volatile private var ready: Pair<UpdateAsset, File>? = null
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .followSslRedirects(false)
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

  override fun definition() = ModuleDefinition {
    Name("OrcaAppUpdater")
    Events("onProgress")

    AsyncFunction("prepare") { asset: UpdateAsset, promise: Promise ->
      if (!busy.compareAndSet(false, true)) {
        promise.reject("ERR_UPDATE_BUSY", "An update operation is already running.", null)
      } else {
        cancelled.set(false)
        ready = null
        executor.execute {
          try {
            asset.validate()
            val context = requireNotNull(appContext.reactContext)
            val directory = File(context.cacheDir, "orca-updates").apply { mkdirs() }
            val apk = File(directory, "${asset.sha256}.apk")
            directory.listFiles()?.filter { it != apk }?.forEach { it.delete() }
            val part = File(directory, "download.part")
            try {
              if (!apk.exists()) {
                download(asset, part)
                checkCancelled()
                verifyApkIdentity(context, part, asset.version)
                require(part.renameTo(apk)) { "Could not save the update." }
              } else {
                verifyCached(asset, apk)
                verifyApkIdentity(context, apk, asset.version)
              }
              checkCancelled()
              ready = asset to apk
              promise.resolve(null)
            } catch (error: Exception) {
              if (!cancelled.get()) apk.delete()
              throw error
            } finally {
              part.delete()
            }
          } catch (error: Exception) {
            promise.reject("ERR_UPDATE_DOWNLOAD", error.message ?: "Could not download the update.", error)
          } finally {
            call = null
            busy.set(false)
          }
        }
      }
    }

    Function("cancel") {
      cancelled.set(true)
      call?.cancel()
    }
    Function("canInstall") {
      canInstall()
    }
    AsyncFunction("install") { promise: Promise ->
      val prepared = ready
      if (prepared == null || !busy.compareAndSet(false, true)) {
        promise.reject("ERR_UPDATE_NOT_READY", "Download the update again before installing.", null)
      } else {
        executor.execute {
          try {
            val (asset, file) = prepared
            cancelled.set(false)
            verifyCached(asset, file)
            val context = requireNotNull(appContext.reactContext)
            verifyApkIdentity(context, file, asset.version)
            main.post {
              try {
                val activity = requireNotNull(appContext.currentActivity) {
                  "Return to Orca to install the update."
                }
                if (!canInstall()) {
                  activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
                  )
                  promise.resolve("permission")
                } else {
                  val uri = FileProvider.getUriForFile(context, "${context.packageName}.app-updates", file)
                  activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    clipData = ClipData.newRawUri("Orca update", uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                  })
                  promise.resolve("installer")
                }
              } catch (error: Exception) {
                promise.reject("ERR_UPDATE_INSTALL", error.message ?: "Could not open Android's installer.", error)
              } finally {
                busy.set(false)
              }
            }
          } catch (error: Exception) {
            ready = null
            promise.reject("ERR_UPDATE_VERIFY", error.message ?: "Download the update again.", error)
            busy.set(false)
          }
        }
      }
    }
    OnDestroy {
      cancelled.set(true)
      call?.cancel()
      executor.shutdownNow()
      client.dispatcher.executorService.shutdown()
      client.connectionPool.evictAll()
    }
  }

  private fun checkCancelled() {
    if (cancelled.get() || Thread.currentThread().isInterrupted) {
      throw InterruptedIOException("Download cancelled.")
    }
  }

  private fun canInstall(): Boolean =
    Build.VERSION.SDK_INT < 26 || appContext.reactContext?.packageManager?.canRequestPackageInstalls() == true

  private fun progress(downloaded: Long, total: Long, verifying: Boolean = false) {
    sendEvent("onProgress", mapOf("downloaded" to downloaded, "total" to total, "verifying" to verifying))
  }

  private fun verifyCached(asset: UpdateAsset, file: File) {
    require(file.exists()) { "Android cleared the cached APK. Download the update again." }
    progress(asset.size, asset.size, true)
    val sink = object : OutputStream() {
      override fun write(value: Int) {}
      override fun write(bytes: ByteArray, offset: Int, length: Int) {}
    }
    file.inputStream().use { input ->
      copyVerifiedApk(input, sink, asset.size, asset.sha256, ::checkCancelled) {}
    }
  }

  private fun download(asset: UpdateAsset, part: File) {
    val request = client.newCall(Request.Builder().url(asset.url).build())
    call = request
    checkCancelled()
    request.execute().use { response ->
      require(response.isSuccessful) { "GitHub could not download the APK. Try again later." }
      val body = requireNotNull(response.body) { "GitHub returned an empty download." }
      require(body.contentLength() == -1L || body.contentLength() == asset.size) {
        "The download size does not match the release."
      }
      var lastPercent = -1L
      body.byteStream().use { input ->
        part.outputStream().use { output ->
          copyVerifiedApk(input, output, asset.size, asset.sha256, ::checkCancelled) { count ->
            val percent = count * 100 / asset.size
            if (percent != lastPercent) {
              lastPercent = percent
              progress(count, asset.size)
            }
          }
        }
      }
      progress(asset.size, asset.size, true)
    }
  }
}
