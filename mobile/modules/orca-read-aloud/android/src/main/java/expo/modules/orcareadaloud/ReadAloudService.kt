package expo.modules.orcareadaloud

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/**
 * Keeps the app at foreground priority with a partial wake lock while the screen is off, and ticks
 * JS through [ReadAloudTicker] because React Native pauses JS timers in the background.
 */
class ReadAloudService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())
  private var tickIntervalMs = DEFAULT_TICK_MS
  private var title = "Orca"
  private var text = "Reading replies aloud"
  private val tick = object : Runnable {
    override fun run() {
      ReadAloudTicker.tick()
      handler.postDelayed(this, tickIntervalMs)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    current = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val control = intent?.action?.let { CONTROLS[it] }
    if (control != null) {
      // A button on a notification left behind by a service that is gone starts nothing.
      if (!isRunning) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
      ReadAloudControls.send(control)
      return START_STICKY
    }
    // A sticky restart with no JS listening means the whole process died; with nothing to tick,
    // the service would only hold a wake lock.
    if (intent == null && ReadAloudTicker.listener == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    title = intent?.getStringExtra(EXTRA_TITLE) ?: title
    text = intent?.getStringExtra(EXTRA_TEXT) ?: text
    tickIntervalMs = intent?.getLongExtra(EXTRA_TICK_MS, DEFAULT_TICK_MS) ?: DEFAULT_TICK_MS
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (wakeLock == null) {
      val power = getSystemService(POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Orca:read-aloud").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    handler.removeCallbacks(tick)
    handler.post(tick)
    isRunning = true
    ReadAloudTileService.refresh(this)
    return START_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping Orca away is the user ending it; the reading goes with it.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    if (current === this) current = null
    handler.removeCallbacks(tick)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    isRunning = false
    ReadAloudTileService.refresh(this)
    super.onDestroy()
  }

  private fun refreshNotification() {
    if (!isRunning) return
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, buildNotification())
  }

  private fun controlIntent(requestCode: Int, action: String): PendingIntent =
    PendingIntent.getService(
      this,
      requestCode,
      Intent(this, ReadAloudService::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

  private fun buildNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Reading replies aloud", NotificationManager.IMPORTANCE_LOW)
      )
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val content = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val actions = buildList {
      if (readerState == "reading" || readerState == "paused") {
        // Dimmed and inert rather than left out, so the buttons keep their places.
        add(
          if (canPrevious) {
            action(R.drawable.orca_read_aloud_previous, "Previous message", controlIntent(3, ACTION_PREVIOUS))
          } else {
            action(R.drawable.orca_read_aloud_previous_off, "No earlier message", null)
          }
        )
        add(
          if (readerState == "reading") {
            action(R.drawable.orca_read_aloud_pause, "Pause", controlIntent(4, ACTION_PAUSE))
          } else {
            action(R.drawable.orca_read_aloud_play, "Resume", controlIntent(5, ACTION_PLAY))
          }
        )
        add(
          if (canNext) {
            action(R.drawable.orca_read_aloud_next, "Next message", controlIntent(6, ACTION_NEXT))
          } else {
            action(R.drawable.orca_read_aloud_next_off, "No message waiting", null)
          }
        )
        add(action(R.drawable.orca_read_aloud_stop, "Stop reading", controlIntent(2, ACTION_STOP_READING)))
      } else if (canRepeat) {
        add(action(R.drawable.orca_read_aloud_replay, "Read the last message again", controlIntent(7, ACTION_REPEAT)))
      }
      add(
        if (isMuted) {
          action(R.drawable.orca_read_aloud_volume_off, "Unmute auto-read", controlIntent(1, ACTION_TOGGLE_MUTE))
        } else {
          action(R.drawable.orca_read_aloud_volume_up, "Mute auto-read", controlIntent(1, ACTION_TOGGLE_MUTE))
        }
      )
    }
    // The monochrome icon expo-notifications generates from app.json, else the launcher icon.
    val smallIcon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    actions.forEach { builder.addAction(it) }
    // MediaStyle shows the buttons while collapsed; with no session token it stays an ordinary
    // notification rather than a Quick Settings player.
    return builder
      .setStyle(Notification.MediaStyle().setShowActionsInCompactView(*IntArray(minOf(actions.size, 3)) { it }))
      .setContentTitle(title)
      .setContentText(readerStatus ?: if (isMuted) MUTED_TEXT else text)
      .setSmallIcon(smallIcon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setContentIntent(content)
      .build()
  }

  private fun action(icon: Int, label: String, intent: PendingIntent?): Notification.Action =
    Notification.Action.Builder(Icon.createWithResource(this, icon), label, intent).build()

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_TICK_MS = "tickMs"
    const val DEFAULT_TICK_MS = 3000L
    private const val ACTION_TOGGLE_MUTE = "expo.modules.orcareadaloud.TOGGLE_MUTE"
    private const val ACTION_STOP_READING = "expo.modules.orcareadaloud.STOP_READING"
    private const val ACTION_PREVIOUS = "expo.modules.orcareadaloud.PREVIOUS"
    private const val ACTION_PAUSE = "expo.modules.orcareadaloud.PAUSE"
    private const val ACTION_PLAY = "expo.modules.orcareadaloud.PLAY"
    private const val ACTION_NEXT = "expo.modules.orcareadaloud.NEXT"
    private const val ACTION_REPEAT = "expo.modules.orcareadaloud.REPEAT"
    private val CONTROLS = mapOf(
      ACTION_TOGGLE_MUTE to ReadAloudControls.TOGGLE_MUTE,
      ACTION_STOP_READING to ReadAloudControls.STOP_READING,
      ACTION_PREVIOUS to ReadAloudControls.PREVIOUS,
      ACTION_PAUSE to ReadAloudControls.PAUSE,
      ACTION_PLAY to ReadAloudControls.PLAY,
      ACTION_NEXT to ReadAloudControls.NEXT,
      ACTION_REPEAT to ReadAloudControls.REPEAT
    )
    private const val MUTED_TEXT = "Auto-read muted"
    private const val CHANNEL_ID = "orca-read-aloud"
    private const val NOTIFICATION_ID = 7417
    @Volatile var isRunning = false
      private set
    @Volatile var isMuted = false
      private set
    @Volatile private var readerState = "idle"
    @Volatile private var readerStatus: String? = null
    @Volatile private var canRepeat = false
    @Volatile private var canPrevious = false
    @Volatile private var canNext = false
    private var current: ReadAloudService? = null

    /** Shows the mute JS decided on, here and on the tile; a later start keeps showing it. */
    fun showMuted(next: Boolean) {
      isMuted = next
      Handler(Looper.getMainLooper()).post {
        current?.let {
          it.refreshNotification()
          ReadAloudTileService.refresh(it)
        }
      }
    }

    /** The reader's state ("idle", "reading", "paused"), which picks the buttons and the text. */
    fun showReader(state: String, status: String?, repeatable: Boolean, previous: Boolean, next: Boolean) {
      if (
        readerState == state && readerStatus == status && canRepeat == repeatable &&
        canPrevious == previous && canNext == next
      ) return
      canPrevious = previous
      canNext = next
      readerState = state
      readerStatus = status
      canRepeat = repeatable
      Handler(Looper.getMainLooper()).post { current?.refreshNotification() }
    }
  }
}

/** The service's ticks, handed to whichever module instance is listening. */
object ReadAloudTicker {
  @Volatile var listener: (() -> Unit)? = null

  fun tick() {
    listener?.invoke()
  }
}

/**
 * The notification's, the tile's and the headset's buttons, handed to whichever module instance
 * is listening; the values are what JS receives.
 */
object ReadAloudControls {
  const val TOGGLE_MUTE = "toggleMute"
  const val STOP_READING = "stop"
  const val PREVIOUS = "previous"
  const val PAUSE = "pause"
  const val PLAY = "play"
  const val NEXT = "next"
  const val REPEAT = "repeat"

  @Volatile var listener: ((String) -> Unit)? = null

  fun send(control: String) {
    listener?.invoke(control)
  }

  fun toggleMute() = send(TOGGLE_MUTE)
}
