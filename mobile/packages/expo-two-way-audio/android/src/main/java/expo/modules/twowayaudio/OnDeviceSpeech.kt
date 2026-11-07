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

  suspend fun availability(locale: String): Map<String, Any?> {
    val target = resolve(locale)?.second
    return mapOf(
      "status" to (target?.status ?: SpeechStatus.UNSUPPORTED).wire,
      "locale" to target?.locale?.toLanguageTag()
    )
  }

  suspend fun download(locale: String): Boolean {
    val (speech, target) = resolve(locale) ?: return false
    if (target.status == SpeechStatus.READY) return true
    val tag = target.locale.toLanguageTag()
    return try {
      speech.download(target) { fraction ->
        sendEvent(SPEECH_DOWNLOAD_PROGRESS_EVENT, mapOf("locale" to tag, "fraction" to fraction))
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Speech download failed for $tag", error)
      false
    }
  }

  suspend fun start(locale: String, sampleRate: Int): Map<String, Any?> {
    val startGeneration = synchronized(lock) { endSession() }
    if (sampleRate != SPEECH_SAMPLE_RATE) return notStarted(SpeechStatus.UNSUPPORTED.wire)
    val (speech, target) = resolve(locale) ?: return notStarted(SpeechStatus.UNSUPPORTED.wire)
    if (target.status != SpeechStatus.READY) return notStarted(SpeechStatus.NEEDS_DOWNLOAD.wire)
    synchronized(lock) {
      if (generation != startGeneration) return notStarted("failed")
      val next = SpeechSession(scope, speech, target) { revision, committed, tentative ->
        sendEvent(
          SPEECH_TEXT_EVENT,
          mapOf("revision" to revision, "committed" to committed, "tentative" to tentative)
        )
      }
      next.result.invokeOnCompletion { error ->
        if (error == null || error is CancellationException) return@invokeOnCompletion
        Log.w(TAG, "On-device speech failed", error)
        sendEvent(SPEECH_ERROR_EVENT, mapOf("code" to speech.failureCode(error)))
      }
      session = next
    }
    return mapOf("started" to true, "locale" to target.locale.toLanguageTag())
  }

  fun feed(pcm: ByteArray) {
    synchronized(lock) { session }?.feed(pcm)
  }

  suspend fun finish(): String {
    val current = synchronized(lock) { session.also { session = null } }
      ?: throw SpeechFailure("failed", "No on-device dictation is running.")
    return try {
      current.finish()
    } catch (error: Exception) {
      current.cancel()
      if (error is SpeechFailure) throw error
      throw SpeechFailure(current.engine.failureCode(error), error.message ?: "On-device speech failed.", error)
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

  private fun endSession(): Int {
    session?.cancel()
    session = null
    return ++generation
  }

  // A ready engine wins over a better one that still needs a download.
  private suspend fun resolve(locale: String): Pair<OnDeviceSpeechEngine, SpeechTarget>? {
    if (engines.isEmpty()) return null
    val candidates = speechLocaleCandidates(locale, Resources.getSystem().configuration.locales[0])
    var pending: Pair<OnDeviceSpeechEngine, SpeechTarget>? = null
    for (engine in engines) {
      val target = try {
        engine.resolve(candidates)
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w(TAG, "Speech availability check failed for $locale", error)
        null
      } ?: continue
      if (target.status == SpeechStatus.READY) return engine to target
      pending = pending ?: (engine to target)
    }
    return pending
  }

  private fun notStarted(reason: String) = mapOf("started" to false, "reason" to reason)

  private companion object {
    const val TAG = "OnDeviceSpeech"
  }
}
