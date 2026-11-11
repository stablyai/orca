package expo.modules.twowayaudio

import expo.modules.kotlin.exception.CodedException
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout

internal const val SPEECH_LOG_TAG = "OnDeviceSpeech"
internal const val SPEECH_BYTES_PER_MS = MIC_SAMPLE_RATE * 2 / 1000

// Wire values of the on-device speech contract (mobile/packages/expo-two-way-audio/src/speech.ts).
internal enum class SpeechStatus(val wire: String) {
  READY("ready"),
  NEEDS_DOWNLOAD("needs-download"),
  UNSUPPORTED("unsupported")
}

// The code reaches JS as the rejection's error code.
internal class SpeechFailure(val failureCode: String, message: String, cause: Throwable? = null) :
  CodedException(failureCode, message, cause)

// What the recognizer would run for a requested locale; variant is the engine's own choice (e.g. a mode).
internal data class SpeechTarget(val status: SpeechStatus, val locale: Locale, val variant: Int)

internal interface OnDeviceSpeechEngine {
  // Never downloads or prompts. Null when no candidate locale is supported.
  suspend fun resolve(candidates: List<Locale>): SpeechTarget?

  // Resolves true once the target's assets are installed.
  suspend fun download(target: SpeechTarget, onProgress: (Double) -> Unit): Boolean

  // Recognizes PCM from audio until it closes. onText gets the whole committed text and the tentative tail.
  suspend fun recognize(target: SpeechTarget, audio: PcmQueue, onText: (String, String) -> Unit): String

  // Maps the engine's own exceptions to a contract code; SpeechFailure carries its code already.
  fun failureCode(error: Throwable): String = "failed"

  // Releases anything the engine keeps between sessions.
  fun close() = Unit
}

// Microphone PCM fed from JS before and while the recognizer reads it. Never blocks the feeding thread.
internal class PcmQueue {
  private val chunks = Channel<ByteArray>(Channel.UNLIMITED)
  private val pendingBytes = AtomicLong()

  fun offer(pcm: ByteArray) {
    if (pcm.isNotEmpty() && chunks.trySend(pcm).isSuccess) pendingBytes.addAndGet(pcm.size.toLong())
  }

  suspend fun take(): ByteArray? =
    chunks.receiveCatching().getOrNull()?.also { pendingBytes.addAndGet(-it.size.toLong()) }

  val pendingMillis get() = pendingBytes.get() / SPEECH_BYTES_PER_MS

  fun close() = chunks.close()

  fun cancel() = chunks.cancel()
}

internal class SpeechSession(
  scope: CoroutineScope,
  val engine: OnDeviceSpeechEngine,
  target: SpeechTarget,
  onText: (String, String) -> Unit
) {
  private val audio = PcmQueue()
  private var lastText: Pair<String, String>? = null

  val result: Deferred<String> = scope.async {
    engine.recognize(target, audio) { committed, tentative ->
      // Recognizers repeat unchanged hypotheses; only a visible change is reported.
      val text = committed to tentative
      if (text != lastText) {
        lastText = text
        onText(committed, tentative)
      }
    }
  }

  init {
    // A failed recognizer stops reading; stop queueing audio for it too.
    result.invokeOnCompletion { audio.cancel() }
  }

  fun feed(pcm: ByteArray) = audio.offer(pcm)

  suspend fun finish(): String {
    audio.close()
    // Queued audio is read at real time; the tail allowance covers the recognizer's final pass.
    return withTimeout(audio.pendingMillis + FINISH_TAIL_MS) { result.await() }
  }

  fun cancel() {
    audio.cancel()
    result.cancel()
  }

  private companion object {
    const val FINISH_TAIL_MS = 15_000L
  }
}
