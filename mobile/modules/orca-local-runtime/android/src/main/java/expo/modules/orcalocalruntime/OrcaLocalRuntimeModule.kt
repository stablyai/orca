package expo.modules.orcalocalruntime

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread

class OrcaLocalRuntimeModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "React context unavailable" }
  private val paths get() = LocalRuntimePaths(context.filesDir)

  private val listener = object : LocalRuntimeState.Listener {
    override fun onStatus(snapshot: LocalRuntimeSnapshot) = sendEvent("onStatus", snapshot.toMap())
    override fun onLog(line: String) = sendEvent("onLog", mapOf("line" to line))
  }

  override fun definition() = ModuleDefinition {
    Name("OrcaLocalRuntime")
    Events("onStatus", "onLog")

    OnStartObserving { LocalRuntimeState.addListener(listener) }
    OnStopObserving { LocalRuntimeState.removeListener(listener) }

    OnCreate {
      // The app must create its external files dir itself; one made by `adb shell mkdir` is unreadable to it.
      LocalRuntimeState.logFile = context.getExternalFilesDir(null)?.let { java.io.File(it, "local-runtime.log") }
      val installed = LocalRuntimeInstaller(context, paths).isInstalled()
      if (LocalRuntimeState.snapshot.phase == LocalRuntimePhase.NOT_INSTALLED && installed) {
        LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.STOPPED) }
      }
      val idle = LocalRuntimeState.snapshot.phase.let { it == LocalRuntimePhase.STOPPED || it == LocalRuntimePhase.NOT_INSTALLED }
      if (installed && idle && LocalRuntimeService.wantsRunning(context)) {
        LocalRuntimeService.start(context, LocalRuntimeService.DEFAULT_PORT)
      }
    }

    Function("isSupported") { Build.SUPPORTED_ABIS.contains("arm64-v8a") }

    Function("getStatus") { LocalRuntimeState.snapshot.toMap() }

    Function("getRecentLog") { LocalRuntimeState.recentLog() }

    AsyncFunction("install") { options: Map<String, Any?>, promise: Promise ->
      val phase = LocalRuntimeState.snapshot.phase
      if (phase == LocalRuntimePhase.INSTALLING || phase == LocalRuntimePhase.RUNNING || phase == LocalRuntimePhase.STARTING) {
        promise.reject(CodedException("ERR_LOCAL_RUNTIME_BUSY", "Stop the local host before reinstalling", null))
        return@AsyncFunction
      }
      val parsed = parseInstallOptions(options)
      thread(name = "orca-local-runtime-install") {
        try {
          LocalRuntimeInstaller(context, paths).install(parsed) { step ->
            LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.INSTALLING, installStep = step, lastError = null) }
          }
          LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.STOPPED, installStep = null) }
          promise.resolve(null)
        } catch (error: Exception) {
          LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.ERROR, lastError = error.message) }
          promise.reject(CodedException("ERR_LOCAL_RUNTIME_INSTALL", error.message ?: "Install failed", error))
        }
      }
    }

    Function("start") { port: Int? ->
      if (!LocalRuntimeInstaller(context, paths).isInstalled()) {
        throw CodedException("ERR_LOCAL_RUNTIME_NOT_INSTALLED", "Install the local host first", null)
      }
      LocalRuntimeService.start(context, port ?: LocalRuntimeService.DEFAULT_PORT)
    }

    Function("stop") { LocalRuntimeService.stop(context) }

    Function("isIgnoringBatteryOptimizations") {
      context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    }

    @SuppressLint("BatteryLife") // A long-lived agent host is the documented exemption case.
    Function("requestIgnoreBatteryOptimizations") {
      context.startActivity(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }
  }

  private fun parseInstallOptions(options: Map<String, Any?>): LocalRuntimeInstallOptions {
    val defaults = LocalRuntimeInstallOptions(orcadBundleUrl = null, orcadBundleSha256 = null)
    @Suppress("UNCHECKED_CAST")
    return LocalRuntimeInstallOptions(
      rootfsUrl = options["rootfsUrl"] as? String ?: defaults.rootfsUrl,
      rootfsSha256 = options["rootfsSha256"] as? String ?: defaults.rootfsSha256,
      orcadBundleUrl = options["orcadBundleUrl"] as? String,
      orcadBundleSha256 = options["orcadBundleSha256"] as? String,
      aptPackages = (options["aptPackages"] as? List<String>) ?: defaults.aptPackages,
      reinstallRootfs = options["reinstallRootfs"] as? Boolean ?: false
    )
  }
}
