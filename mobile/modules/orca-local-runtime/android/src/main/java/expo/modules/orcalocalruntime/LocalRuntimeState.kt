package expo.modules.orcalocalruntime

import java.io.File
import java.util.concurrent.CopyOnWriteArraySet

enum class LocalRuntimePhase(val wire: String) {
  NOT_INSTALLED("not_installed"),
  INSTALLING("installing"),
  STOPPED("stopped"),
  STARTING("starting"),
  RUNNING("running"),
  ERROR("error")
}

data class LocalRuntimeSnapshot(
  val phase: LocalRuntimePhase,
  val installStep: String?,
  val endpoint: String?,
  val pairingUrl: String?,
  val lastError: String?,
  val restartCount: Int,
  val webClientUrl: String? = null
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "phase" to phase.wire,
    "installStep" to installStep,
    "endpoint" to endpoint,
    "pairingUrl" to pairingUrl,
    "lastError" to lastError,
    "restartCount" to restartCount,
    "webClientUrl" to webClientUrl
  )
}

/** Process-wide state shared by the service (writer) and the JS module (reader/subscriber). */
object LocalRuntimeState {
  private const val MAX_LOG_LINES = 400
  private const val MAX_LOG_FILE_BYTES = 4L * 1024 * 1024

  interface Listener {
    fun onStatus(snapshot: LocalRuntimeSnapshot)
    fun onLog(line: String)
  }

  // A set: Expo calls OnStartObserving once per event name, so the same listener arrives twice.
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val log = ArrayDeque<String>()

  @Volatile
  var snapshot = LocalRuntimeSnapshot(LocalRuntimePhase.NOT_INSTALLED, null, null, null, null, 0)
    private set

  fun addListener(listener: Listener) = listeners.add(listener)

  fun removeListener(listener: Listener) = listeners.remove(listener)

  fun update(transform: (LocalRuntimeSnapshot) -> LocalRuntimeSnapshot) {
    val next = synchronized(this) {
      snapshot = transform(snapshot)
      snapshot
    }
    listeners.forEach { it.onStatus(next) }
  }

  /** Mirrors the log to disk so `adb pull` and bug reports see the whole run, not the tail. */
  @Volatile
  var logFile: File? = null

  fun appendLog(line: String) {
    synchronized(log) {
      if (log.size >= MAX_LOG_LINES) log.removeFirst()
      log.addLast(line)
      logFile?.let { file ->
        try {
          if (file.length() > MAX_LOG_FILE_BYTES) file.renameTo(File(file.path + ".1"))
          file.appendText(line + "\n")
        } catch (_: Exception) {
          // Disk logging is best-effort; the in-memory tail still reaches the UI.
        }
      }
    }
    listeners.forEach { it.onLog(line) }
  }

  fun recentLog(): List<String> = synchronized(log) { log.toList() }
}
