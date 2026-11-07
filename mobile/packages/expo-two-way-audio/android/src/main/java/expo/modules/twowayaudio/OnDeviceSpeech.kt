package expo.modules.twowayaudio

import android.content.Context
import android.content.res.Resources
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

internal const val SPEECH_TEXT_EVENT = "onSpeechText"
internal const val SPEECH_ERROR_EVENT = "onSpeechError"
internal const val SPEECH_DOWNLOAD_PROGRESS_EVENT = "onSpeechDownloadProgress"

// One on-device dictation at a time, fed with the microphone PCM the page already receives.
internal class OnDeviceSpeech(
  context: Context,
  private val sendEvent: (String, Map<String, Any?>) -> Unit
) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  // Best first: ML Kit (AICore phones), then Android's own on-device recognizer.
  private val engines: List<OnDeviceSpeechEngine> = buildList {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(MlKitSpeechEngine())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(PlatformSpeechEngine(context))
  }
  private val lock = Any()
  private var session: SpeechSession? = null
  // Bumped by every start and cancel, so a start that resolves after a newer call stays unstarted.
  private var generation = 0
  // Never reset, so a reader keeping the highest revision drops a late event from an earlier session.
  private var revision = 0

  // Rejects with code "busy" when the speech service didn't answer in time; asking again is safe.
  suspend fun availability(locale: String): Map<String, Any?> {
    val target = resolve(locale)?.second
    return mapOf(
      "status" to (target?.status ?: SpeechStatus.UNSUPPORTED).wire,
      "locale" to target?.locale?.toLanguageTag()
    )
  }

  suspend fun download(locale: String): Boolean {
    val (speech, target) = try {
      resolve(locale)
    } catch (_: SpeechFailure) {
      null
    } ?: return false
    if (target.status == SpeechStatus.READY) return true
    val tag = target.locale.toLanguageTag()
    return try {
      speech.download(target) { fraction ->
        sendEvent(SPEECH_DOWNLOAD_PROGRESS_EVENT, mapOf("locale" to tag, "fraction" to fraction))
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(SPEECH_LOG_TAG, "Speech download failed for $tag", error)
      false
    }
  }

  suspend fun start(locale: String, sampleRate: Int): Map<String, Any?> {
    val (previous, startGeneration) = synchronized(lock) { endSession() to generation }
    // Its teardown releases the recognizer this session may reuse; let it land first.
    previous?.result?.join()
    if (sampleRate != MIC_SAMPLE_RATE) return notStarted(SpeechStatus.UNSUPPORTED.wire)
    val resolved = try {
      resolve(locale)
    } catch (error: SpeechFailure) {
      return notStarted(error.failureCode)
    }
    val (speech, target) = resolved ?: return notStarted(SpeechStatus.UNSUPPORTED.wire)
    if (target.status != SpeechStatus.READY) return notStarted(SpeechStatus.NEEDS_DOWNLOAD.wire)
    synchronized(lock) {
      if (generation != startGeneration) return notStarted("failed")
      lateinit var next: SpeechSession
      next = SpeechSession(scope, speech, target) { committed, tentative ->
        emitIfCurrent(next) {
          revision += 1
          SPEECH_TEXT_EVENT to mapOf("revision" to revision, "committed" to committed, "tentative" to tentative)
        }
      }
      session = next
      // Registered after the session is current, so a failure that already happened is still reported.
      next.result.invokeOnCompletion { error ->
        if (error == null || error is CancellationException) return@invokeOnCompletion
        Log.w(SPEECH_LOG_TAG, "On-device speech failed", error)
        emitIfCurrent(next) { SPEECH_ERROR_EVENT to mapOf("code" to failureCode(speech, error)) }
      }
    }
    return mapOf("started" to true, "locale" to target.locale.toLanguageTag())
  }

  fun feed(pcm: ByteArray) {
    synchronized(lock) { session }?.feed(pcm)
  }

  // The session stays current until its final text is in, so a start or cancel meanwhile still ends it.
  suspend fun finish(): String {
    val current = synchronized(lock) { session }
      ?: throw SpeechFailure("failed", "No on-device dictation is running.")
    return try {
      current.finish()
    } catch (error: Exception) {
      current.cancel()
      if (error is SpeechFailure) throw error
      throw SpeechFailure(failureCode(current.engine, error), error.message ?: "On-device speech failed.", error)
    } finally {
      synchronized(lock) { if (session === current) session = null }
    }
  }

  fun cancel() {
    synchronized(lock) { endSession() }
  }

  fun destroy() {
    cancel()
    scope.cancel()
    engines.forEach { it.close() }
  }

  private fun emitIfCurrent(owner: SpeechSession, event: () -> Pair<String, Map<String, Any?>>) {
    val (name, body) = synchronized(lock) { if (session === owner) event() else null } ?: return
    sendEvent(name, body)
  }

  private fun endSession(): SpeechSession? {
    val ended = session
    ended?.cancel()
    session = null
    generation += 1
    return ended
  }

  // A ready engine wins over a better one that still needs a download. Throws a busy SpeechFailure when
  // no engine is usable but one couldn't answer in time, so the caller retries rather than reading unsupported.
  private suspend fun resolve(locale: String): Pair<OnDeviceSpeechEngine, SpeechTarget>? {
    if (engines.isEmpty()) return null
    val candidates = speechLocaleCandidates(locale, Resources.getSystem().configuration.locales[0])
    var pending: Pair<OnDeviceSpeechEngine, SpeechTarget>? = null
    var busy: SpeechFailure? = null
    for (engine in engines) {
      val target = try {
        engine.resolve(candidates)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w(SPEECH_LOG_TAG, "Speech availability check failed for $locale", error)
        if (error is SpeechFailure && error.failureCode == "busy") busy = error
        null
      } ?: continue
      if (target.status == SpeechStatus.READY) return engine to target
      pending = pending ?: (engine to target)
    }
    if (pending == null && busy != null) throw busy
    return pending
  }

  private fun notStarted(reason: String) = mapOf("started" to false, "reason" to reason)

  private fun failureCode(engine: OnDeviceSpeechEngine, error: Throwable) =
    (error as? SpeechFailure)?.failureCode ?: engine.failureCode(error)
}
