package expo.modules.orcalivealerts

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Renders the live agent notification that mobile/src/live-alerts computes. All wording and state
 * logic stays in TypeScript, where CI tests it; this module posts, updates and ends.
 */
class OrcaLiveAlertsModule : Module() {
  @Volatile private var keepAliveTaskId: Int? = null

  private val sink =
    object : LiveAlertEventSink {
      override fun emit(name: String, body: Map<String, Any?>) {
        this@OrcaLiveAlertsModule.sendEvent(name, body)
      }

      override fun serviceStopped() {
        endKeepAlive()
      }
    }

  override fun definition() = ModuleDefinition {
    Name("OrcaLiveAlerts")

    Events(EVENT_OPEN_TARGET, LiveAgentService.EVENT_DISMISSED, LiveAgentService.EVENT_TICK)

    OnCreate {
      LiveAlertBridge.attachSink(sink)
    }

    OnDestroy {
      endKeepAlive()
      LiveAlertBridge.detachSink(sink)
    }

    Function("getCapabilities") {
      capabilities()
    }

    // Main queue: service and notification calls stay ordered, and HeadlessJsTaskContext must
    // start tasks on the UI thread.
    AsyncFunction("show") { payloadJson: String ->
      show(payloadJson)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("finish") { payloadJson: String? ->
      finish(LiveAlertPayload.parse(payloadJson))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancel") {
      finish(null)
    }.runOnQueue(Queues.MAIN)

    Function("consumeLaunchTarget") {
      takeTarget(appContext.currentActivity?.intent)
    }

    Function("openPromotionSettings") {
      openPromotionSettings()
    }

    Function("openAppNotificationSettings") {
      openAppNotificationSettings()
    }

    Function("openAppDetailsSettings") {
      openAppDetailsSettings()
    }

    OnNewIntent { intent ->
      val target = takeTarget(intent)
      if (target != null) {
        sendEvent(EVENT_OPEN_TARGET, mapOf("target" to target))
      }
    }
  }

  private fun capabilities(): Map<String, Any> {
    val manager = notificationManager()
    val sdk = Build.VERSION.SDK_INT
    val canPostPromoted =
      Build.VERSION.SDK_INT >= 36 && manager?.canPostPromotedNotifications() == true
    return mapOf(
      "sdkInt" to sdk,
      "notificationsEnabled" to (manager?.areNotificationsEnabled() == true),
      "promotionApi" to (sdk >= 36),
      "canPostPromoted" to canPostPromoted
    )
  }

  private fun show(payloadJson: String): String {
    val payload = LiveAlertPayload.parse(payloadJson) ?: return RESULT_UNAVAILABLE
    val context = reactContextOrNull() ?: return RESULT_UNAVAILABLE
    val manager = notificationManager() ?: return RESULT_UNAVAILABLE
    if (!manager.areNotificationsEnabled()) {
      return RESULT_UNAVAILABLE
    }
    LiveAlertNotificationFactory.ensureChannel(context)
    LiveAlertBridge.latestPayload = payload
    val running = LiveAlertBridge.service
    if (running != null) {
      running.show(payload)
      return RESULT_FOREGROUND_SERVICE
    }
    // Updates never call startForegroundService again; only the first post starts the service.
    val intent = Intent(context, LiveAgentService::class.java).setAction(LiveAgentService.ACTION_SHOW)
    return try {
      if (Build.VERSION.SDK_INT >= 26) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      startKeepAlive()
      RESULT_FOREGROUND_SERVICE
    } catch (e: RuntimeException) {
      // Android 12+ refuses foreground-service starts from the background
      // (ForegroundServiceStartNotAllowedException); post the same notification without one.
      Log.w(LiveAgentService.TAG, "fgs=not-allowed error=${e.javaClass.simpleName}")
      val notification = LiveAlertNotificationFactory.build(context, payload)
      manager.notify(LiveAlertNotificationFactory.NOTIFICATION_ID, notification)
      RESULT_NOTIFICATION_ONLY
    }
  }

  private fun finish(finalPayload: LiveAlertPayload?) {
    LiveAlertBridge.latestPayload = null
    val running = LiveAlertBridge.service
    if (running != null) {
      running.finish(finalPayload)
    } else {
      val context = reactContextOrNull()
      val manager = notificationManager()
      if (context != null && manager != null) {
        if (finalPayload != null) {
          val notification = LiveAlertNotificationFactory.build(context, finalPayload)
          manager.notify(LiveAlertNotificationFactory.NOTIFICATION_ID, notification)
        } else {
          manager.cancel(LiveAlertNotificationFactory.NOTIFICATION_ID)
        }
      }
    }
    endKeepAlive()
  }

  // React Native pauses JS timers in the background unless a Headless JS task is running; this one
  // runs (no timeout) for as long as the foreground service does. JS registers it in index.js.
  private fun startKeepAlive() {
    if (keepAliveTaskId != null) {
      return
    }
    val reactContext = reactContextOrNull() as? ReactContext ?: return
    val config = HeadlessJsTaskConfig(KEEP_ALIVE_TASK, Arguments.createMap(), 0L, true)
    keepAliveTaskId =
      try {
        HeadlessJsTaskContext.getInstance(reactContext).startTask(config)
      } catch (e: RuntimeException) {
        Log.w(LiveAgentService.TAG, "keepalive=failed error=${e.javaClass.simpleName}")
        null
      }
  }

  private fun endKeepAlive() {
    val taskId = keepAliveTaskId ?: return
    keepAliveTaskId = null
    val reactContext = reactContextOrNull() as? ReactContext ?: return
    HeadlessJsTaskContext.getInstance(reactContext).finishTask(taskId)
  }

  // Read once: a later resume with the same intent must not navigate again.
  private fun takeTarget(intent: Intent?): String? {
    if (intent == null) {
      return null
    }
    val target = intent.getStringExtra(LiveAlertNotificationFactory.EXTRA_TARGET) ?: return null
    intent.removeExtra(LiveAlertNotificationFactory.EXTRA_TARGET)
    return target
  }

  // The live-update page calls this screen ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS; the Settings
  // reference has ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS. Use the action string itself.
  private fun openPromotionSettings() {
    val context = reactContextOrNull() ?: return
    val intent =
      Intent(ACTION_PROMOTION_SETTINGS).putExtra(EXTRA_APP_PACKAGE, context.packageName)
    if (!launch(context, intent)) {
      openAppNotificationSettings()
    }
  }

  private fun openAppNotificationSettings() {
    val context = reactContextOrNull() ?: return
    val intent =
      Intent(ACTION_APP_NOTIFICATION_SETTINGS).putExtra(EXTRA_APP_PACKAGE, context.packageName)
    if (Build.VERSION.SDK_INT < 26 || !launch(context, intent)) {
      openAppDetailsSettings()
    }
  }

  // App info: on ColorOS, Battery usage is where "Unrestricted" / background activity is set.
  private fun openAppDetailsSettings() {
    val context = reactContextOrNull() ?: return
    val uri = Uri.fromParts("package", context.packageName, null)
    launch(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri))
  }

  private fun launch(context: Context, intent: Intent): Boolean {
    val starter: Context = appContext.currentActivity ?: context
    return try {
      starter.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: ActivityNotFoundException) {
      false
    }
  }

  private fun notificationManager(): NotificationManager? =
    reactContextOrNull()?.getSystemService(NotificationManager::class.java)

  // appContext throws once the module is torn down; a late service callback must not crash.
  private fun reactContextOrNull(): Context? =
    try {
      appContext.reactContext
    } catch (e: IllegalArgumentException) {
      null
    }

  private companion object {
    const val EVENT_OPEN_TARGET = "onOpenTarget"
    const val KEEP_ALIVE_TASK = "OrcaLiveAlertsKeepAlive"
    const val RESULT_FOREGROUND_SERVICE = "foreground-service"
    const val RESULT_NOTIFICATION_ONLY = "notification-only"
    const val RESULT_UNAVAILABLE = "unavailable"
    const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"
    const val ACTION_APP_NOTIFICATION_SETTINGS = "android.settings.APP_NOTIFICATION_SETTINGS"
    const val EXTRA_APP_PACKAGE = "android.provider.extra.APP_PACKAGE"
  }
}
