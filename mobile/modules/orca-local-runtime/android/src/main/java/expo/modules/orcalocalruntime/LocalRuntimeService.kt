package expo.modules.orcalocalruntime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Owns the proot → orcad process tree. Foreground so Android does not reap it with the UI, and
 * supervised so a crashed host comes back without the user reopening the app.
 */
class LocalRuntimeService : Service() {
  private var process: Process? = null

  @Volatile
  private var prootPid: Int? = null
  private var supervisor: Thread? = null
  private var wakeLock: PowerManager.WakeLock? = null

  @Volatile
  private var stopping = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // The notification's Stop comes straight here, not through stop(), so record the intent too.
      getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_WANT_RUNNING, false).apply()
      shutdown()
      return START_NOT_STICKY
    }
    enterForeground()
    if (supervisor?.isAlive != true) {
      stopping = false
      val port = intent?.getIntExtra(EXTRA_PORT, DEFAULT_PORT) ?: DEFAULT_PORT
      supervisor = Thread({ supervise(port) }, "orca-local-runtime").apply { start() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }

  private fun supervise(port: Int) {
    LocalRuntimeState.logFile = getExternalFilesDir(null)?.let { java.io.File(it, "local-runtime.log") }
    val paths = LocalRuntimePaths(filesDir)
    try {
      LocalRuntimeInstaller(this, paths).installProot()
      GuestGroups.register(paths)
    } catch (error: Exception) {
      LocalRuntimeState.appendLog("[local-runtime] pre-start refresh failed: ${error.message}")
    }
    GuestProcessTree.killStrays(paths.rootfs.path)
    var backoffMs = INITIAL_BACKOFF_MS
    while (!stopping) {
      LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.STARTING, lastError = null) }
      val startedAt = System.currentTimeMillis()
      val exitCode = runOnce(paths, port)
      if (stopping) break
      // A run that stayed up a while was healthy; restart it promptly rather than at the old backoff.
      if (System.currentTimeMillis() - startedAt > HEALTHY_RUN_MS) backoffMs = INITIAL_BACKOFF_MS
      LocalRuntimeState.update {
        it.copy(
          phase = LocalRuntimePhase.ERROR,
          endpoint = null,
          lastError = "orcad exited with code $exitCode; restarting in ${backoffMs / 1000}s",
          restartCount = it.restartCount + 1
        )
      }
      try {
        Thread.sleep(backoffMs)
      } catch (_: InterruptedException) {
        break
      }
      backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
    }
    LocalRuntimeState.update { it.copy(phase = LocalRuntimePhase.STOPPED, endpoint = null, webClientUrl = null) }
  }

  private fun runOnce(paths: LocalRuntimePaths, port: Int): Int {
    val started = try {
      // `echo $$; exec` reports proot's pid first, which Stop needs to signal the whole guest tree.
      ProcessBuilder(listOf("/system/bin/sh", "-c", "echo \$\$; exec \"\$@\"", "sh") + ProotCommand.orcadArgv(paths, port))
        .apply { environment().putAll(ProotCommand.hostEnv(paths)) }
        .start()
    } catch (error: Exception) {
      LocalRuntimeState.appendLog("[local-runtime] failed to start: ${error.message}")
      return -1
    }
    process = started
    val stdout = started.inputStream.bufferedReader()
    prootPid = try {
      stdout.readLine()?.trim()?.toIntOrNull()
    } catch (_: java.io.IOException) {
      null
    }
    val stderrPump = Thread {
      pumpLines(started.errorStream.bufferedReader()) { LocalRuntimeState.appendLog(it) }
    }.apply { start() }
    pumpLines(stdout) { line ->
      val readiness = OrcadReadinessParser.parse(line)
      if (readiness == null) {
        LocalRuntimeState.appendLog(line)
        return@pumpLines
      }
      LocalRuntimeState.update {
        it.copy(
          phase = LocalRuntimePhase.RUNNING,
          endpoint = readiness.endpoint,
          pairingUrl = readiness.pairingUrl ?: it.pairingUrl,
          webClientUrl = readiness.webClientUrl,
          lastError = readiness.pairingUnavailableReason?.let { reason -> "pairing unavailable: $reason" }
        )
      }
    }
    // shutdown() interrupts this thread; that ends the run, it must not escape as a crash.
    val code = try {
      started.waitFor().also { stderrPump.join(1_000) }
    } catch (_: InterruptedException) {
      -1
    }
    process = null
    prootPid = null
    return code
  }

  /** Stop closes these streams under the readers; that is the end of output, not a crash. */
  private fun pumpLines(reader: java.io.BufferedReader, onLine: (String) -> Unit) {
    try {
      reader.forEachLine(onLine)
    } catch (_: java.io.IOException) {
      // Closed by destroy() during shutdown or by the child exiting.
    }
  }

  private fun shutdown() {
    stopping = true
    val pid = prootPid
    val running = process
    // Off the main thread: the tree gets a grace period to exit before SIGKILL.
    Thread({
      if (pid != null) GuestProcessTree.terminate(pid) else running?.destroy()
    }, "orca-local-runtime-stop").start()
    supervisor?.interrupt()
    supervisor = null
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun enterForeground() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "On-device Orca host", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val stopIntent = PendingIntent.getService(
      this, 0, Intent(this, LocalRuntimeService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this))
      .setContentTitle("Orca host running")
      .setContentText("Terminals and agents keep running on this device.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(launch)
      .addAction(Notification.Action.Builder(null, "Stop", stopIntent).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (wakeLock == null) {
      // Why: Doze freezes the CPU under a live agent run otherwise; the user stops it from the notification.
      wakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "orca:local-runtime")
        .apply { acquire() }
    }
  }

  companion object {
    const val ACTION_STOP = "expo.modules.orcalocalruntime.STOP"
    const val EXTRA_PORT = "port"
    const val DEFAULT_PORT = 6768
    private const val CHANNEL_ID = "orca-local-runtime"
    private const val NOTIFICATION_ID = 6768
    private const val INITIAL_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 60_000L
    private const val HEALTHY_RUN_MS = 60_000L

    private const val PREFS = "orca-local-runtime"
    private const val PREF_WANT_RUNNING = "wantRunning"

    fun start(context: Context, port: Int) {
      setWantRunning(context, true)
      val intent = Intent(context, LocalRuntimeService::class.java).putExtra(EXTRA_PORT, port)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    fun stop(context: Context) {
      setWantRunning(context, false)
      context.startService(Intent(context, LocalRuntimeService::class.java).setAction(ACTION_STOP))
    }

    /** True when the user left the host on; an app update or process kill must not silently turn it off. */
    fun wantsRunning(context: Context): Boolean =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_WANT_RUNNING, false)

    private fun setWantRunning(context: Context, value: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_WANT_RUNNING, value).apply()
    }
  }
}
