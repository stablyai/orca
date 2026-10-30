package expo.modules.orcalivealerts

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Foreground service of type connectedDevice: it keeps the app's network link to the paired
 * desktop open while agents run there, owns the live notification, and wakes JavaScript every 3 s
 * (React Native pauses JS timers when the screen is off). The module starts it only while at least
 * one agent is active; it is never sticky and holds no wake lock.
 */
class LiveAgentService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var foreground = false
  private var loggedPhase: String? = null
  private val tick =
    object : Runnable {
      override fun run() {
        LiveAlertBridge.emit(EVENT_TICK)
        handler.postDelayed(this, TICK_MS)
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    LiveAlertBridge.attachService(this)
    LiveAlertNotificationFactory.ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SHOW -> {
        val payload = LiveAlertBridge.latestPayload
        if (payload != null) {
          show(payload)
        } else if (!foreground && startInForeground(placeholderNotification())) {
          // The session finished before this start arrived; the start still owed startForeground.
          finish(null)
        }
      }
      ACTION_HIDE,
      ACTION_DISMISSED -> dismiss()
      else -> {
        if (!foreground) {
          stopSelf()
        }
      }
    }
    return START_NOT_STICKY
  }

  /** Posts or updates the notification; the first call moves the service to the foreground. */
  internal fun show(payload: LiveAlertPayload) {
    val notification = LiveAlertNotificationFactory.build(this, payload)
    if (foreground) {
      notificationManager()?.notify(LiveAlertNotificationFactory.NOTIFICATION_ID, notification)
    } else if (!startInForeground(notification)) {
      return
    }
    logPhase(payload, notification)
  }

  /** Ends the session: the notification becomes [finalPayload] when given, else it is removed. */
  internal fun finish(finalPayload: LiveAlertPayload?) {
    handler.removeCallbacks(tick)
    if (finalPayload != null) {
      stopForeground(STOP_FOREGROUND_DETACH)
      notificationManager()?.notify(
        LiveAlertNotificationFactory.NOTIFICATION_ID,
        LiveAlertNotificationFactory.build(this, finalPayload)
      )
    } else {
      stopForeground(STOP_FOREGROUND_REMOVE)
      notificationManager()?.cancel(LiveAlertNotificationFactory.NOTIFICATION_ID)
    }
    foreground = false
    loggedPhase = null
    Log.i(TAG, "fgs=stopped final=${finalPayload != null}")
    LiveAlertBridge.detachService(this)
    stopSelf()
  }

  // connectedDevice has no time limit today; if a later release adds one, stop within its grace.
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "fgs=timeout type=$fgsType")
    finish(null)
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    LiveAlertBridge.detachService(this)
    super.onDestroy()
  }

  private fun dismiss() {
    finish(null)
    LiveAlertBridge.emit(EVENT_DISMISSED)
  }

  private fun startInForeground(notification: Notification): Boolean {
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(
          LiveAlertNotificationFactory.NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        )
      } else {
        startForeground(LiveAlertNotificationFactory.NOTIFICATION_ID, notification)
      }
    } catch (e: RuntimeException) {
      // Background-start limits or a missing type prerequisite: keep the notification without the
      // service; the module tries the service again on a later update.
      Log.w(TAG, "fgs=start-failed error=${e.javaClass.simpleName}")
      notificationManager()?.notify(LiveAlertNotificationFactory.NOTIFICATION_ID, notification)
      stopSelf()
      return false
    }
    foreground = true
    Log.i(TAG, "fgs=started type=connectedDevice sdk=${Build.VERSION.SDK_INT}")
    handler.removeCallbacks(tick)
    handler.postDelayed(tick, TICK_MS)
    return true
  }

  private fun placeholderNotification(): Notification =
    LiveAlertNotificationFactory.build(this, LiveAlertPayload.placeholder())

  // Lifecycle facts only. Titles and text can quote shell commands, so they are never logged.
  private fun logPhase(payload: LiveAlertPayload, notification: Notification) {
    if (payload.phase == loggedPhase) {
      return
    }
    loggedPhase = payload.phase
    val agents = payload.progressTotal ?: 1
    if (Build.VERSION.SDK_INT >= 36) {
      val canPost = notificationManager()?.canPostPromotedNotifications()
      val promotable = notification.hasPromotableCharacteristics()
      Log.i(
        TAG,
        "phase=${payload.phase} agents=$agents canPostPromoted=$canPost promotable=$promotable"
      )
    } else {
      Log.i(TAG, "phase=${payload.phase} agents=$agents sdk=${Build.VERSION.SDK_INT}")
    }
  }

  private fun notificationManager(): NotificationManager? =
    getSystemService(NotificationManager::class.java)

  companion object {
    const val ACTION_SHOW = "expo.modules.orcalivealerts.SHOW"
    const val ACTION_HIDE = "expo.modules.orcalivealerts.HIDE"
    const val ACTION_DISMISSED = "expo.modules.orcalivealerts.DISMISSED"
    const val EVENT_TICK = "onTick"
    const val EVENT_DISMISSED = "onDismissed"
    const val TAG = "OrcaLiveAlerts"
    private const val TICK_MS = 3_000L
  }
}
