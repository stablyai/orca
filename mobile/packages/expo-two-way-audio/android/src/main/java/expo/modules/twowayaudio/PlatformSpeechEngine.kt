package expo.modules.twowayaudio

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.speech.ModelDownloadListener
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

// Android's own on-device recognizer (Google's speech services on most phones), for phones without
// AICore. API 33 is the floor because that is when it can read our PCM instead of opening the mic.
@RequiresApi(33)
internal class PlatformSpeechEngine(private val context: Context) : OnDeviceSpeechEngine {
  // One recognizer for checks, downloads and sessions, kept until close. Destroying a recognizer unbinds
  // the app's connection to the service: other recognizers then fail with ERROR_SERVER_DISCONNECTED and
  // a request sent while it unbinds is dropped without a callback. Main thread only.
  private var shared: SpeechRecognizer? = null

  override suspend fun resolve(candidates: List<Locale>): SpeechTarget? {
    if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return null
    for (locale in candidates) {
      val support = support(locale) ?: continue
      val status = when {
        support.installedOnDeviceLanguages.containsTag(locale) -> SpeechStatus.READY
        support.pendingOnDeviceLanguages.containsTag(locale) ||
          support.supportedOnDeviceLanguages.containsTag(locale) -> SpeechStatus.NEEDS_DOWNLOAD
        else -> continue
      }
      return SpeechTarget(status, locale, 0)
    }
    return null
  }

  override suspend fun download(target: SpeechTarget, onProgress: (Double) -> Unit): Boolean {
    val intent = recognizeIntent(target.locale)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // API 33 reports no download events; the next availability check sees the result.
      withContext(Dispatchers.Main) { recognizer().triggerModelDownload(intent) }
      return false
    }
    // No timeout: the download waits for the user to approve it in the system dialog.
    return request(timeoutMs = null) { recognizer, done: (Boolean) -> Unit ->
      recognizer.triggerModelDownload(intent, context.mainExecutor, object : ModelDownloadListener {
        override fun onProgress(completedPercent: Int) = onProgress(completedPercent / 100.0)
        override fun onSuccess() = done(true)
        override fun onScheduled() = done(false)
        override fun onError(error: Int) = done(false)
      })
    } ?: false
  }

  override suspend fun recognize(
    target: SpeechTarget,
    audio: PcmQueue,
    onText: (String, String) -> Unit
  ): String = PacedPcmPipe().use { pipe ->
    val events = Channel<RecognitionEvent>(Channel.UNLIMITED)
    var listening: SpeechRecognizer? = null
    try {
      // Not cancellable, and inside the try: a session cancelled mid-setup must still be cancelled below.
      withContext(NonCancellable + Dispatchers.Main) {
        listening = recognizer().apply {
          setRecognitionListener(EventListener(events))
          startListening(recognizeIntent(target.locale).withAudioSource(pipe))
        }
      }
      coroutineScope {
        val writer = launch { pipe.pump(audio) }
        val committed = StringBuilder()
        var tentative = ""
        for (event in events) {
          when (event) {
            is RecognitionEvent.Partial -> tentative = segmentTail(committed, event.text)
            is RecognitionEvent.Segment -> {
              committed.append(segmentTail(committed, event.text))
              tentative = ""
            }
            is RecognitionEvent.Failed -> {
              if (event.error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) {
                withContext(Dispatchers.Main) { shared?.let(::drop) }
              }
              throw SpeechFailure(failureCode(event.error), "Recognizer error ${event.error}")
            }
            RecognitionEvent.Ended -> break
          }
          onText(committed.toString(), tentative)
        }
        if (writer.isActive) {
          writer.cancel()
          throw SpeechFailure("failed", "Speech recognition ended before the recording did.")
        }
        committed.append(tentative)
        committed.toString()
      }
    } catch (error: Throwable) {
      val started = listening
      if (started != null) withContext(NonCancellable + Dispatchers.Main) { runCatching { started.cancel() } }
      throw error
    }
  }

  private fun failureCode(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "unsupported"
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "needs-download"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "busy"
    else -> "failed"
  }

  override fun close() {
    context.mainExecutor.execute { shared?.let(::drop) }
  }

  // A disconnected recognizer is replaced once; the new one binds the service afresh.
  private suspend fun support(locale: Locale): RecognitionSupport? {
    repeat(2) {
      val (support, error) = request(SUPPORT_TIMEOUT_MS) { recognizer, done: (Pair<RecognitionSupport?, Int>) -> Unit ->
        recognizer.checkRecognitionSupport(
          recognizeIntent(locale),
          context.mainExecutor,
          object : RecognitionSupportCallback {
            override fun onSupportResult(support: RecognitionSupport) = done(support to 0)
            override fun onError(error: Int) = done(null to error)
          }
        )
      } ?: return null
      if (error != SpeechRecognizer.ERROR_SERVER_DISCONNECTED) {
        if (support == null) Log.w(SPEECH_LOG_TAG, "Recognition support check for $locale failed: $error")
        return support
      }
      withContext(Dispatchers.Main) { shared?.let(::drop) }
    }
    return null
  }

  private fun recognizer(): SpeechRecognizer =
    shared ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also { shared = it }

  private fun drop(recognizer: SpeechRecognizer) {
    recognizer.destroy()
    if (shared === recognizer) shared = null
  }

  // Runs one callback-style request on the shared recognizer. Null when it timed out; the recognizer is
  // then replaced, since a dropped request means its binding is gone.
  private suspend fun <T : Any> request(
    timeoutMs: Long?,
    send: (SpeechRecognizer, (T) -> Unit) -> Unit
  ): T? = withContext(Dispatchers.Main) {
    val recognizer = recognizer()
    val call: suspend () -> T = {
      suspendCancellableCoroutine { continuation ->
        send(recognizer) { if (continuation.isActive) continuation.resume(it) }
      }
    }
    val answer = if (timeoutMs == null) call() else withTimeoutOrNull(timeoutMs) { call() }
    if (answer == null) drop(recognizer)
    answer
  }

  private fun recognizeIntent(locale: Locale) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())

  private fun Intent.withAudioSource(pipe: PacedPcmPipe) = this
    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    .putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe.readEnd)
    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, MIC_SAMPLE_RATE)
    // Keep listening across pauses until the audio source ends, reporting each segment as it closes.
    .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)

  private companion object {
    const val SUPPORT_TIMEOUT_MS = 3_000L
  }
}

private fun List<String>.containsTag(locale: Locale) = any { it.equals(locale.toLanguageTag(), ignoreCase = true) }

// What a segment adds after the text so far. Segments arrive without separators; scripts written
// without spaces (Chinese, Japanese, Thai) stay joined.
private fun segmentTail(text: CharSequence, segment: String): String {
  val next = segment.trim()
  if (next.isEmpty() || text.isEmpty()) return next
  val spaced = !isUnspacedScript(Character.codePointBefore(text, text.length)) &&
    !isUnspacedScript(next.codePointAt(0))
  return if (spaced) " $next" else next
}

private fun isUnspacedScript(codePoint: Int) = when (Character.UnicodeScript.of(codePoint)) {
  Character.UnicodeScript.HAN,
  Character.UnicodeScript.HIRAGANA,
  Character.UnicodeScript.KATAKANA,
  Character.UnicodeScript.THAI -> true
  else -> false
}

private sealed interface RecognitionEvent {
  data class Partial(val text: String) : RecognitionEvent
  data class Segment(val text: String) : RecognitionEvent
  data class Failed(val error: Int) : RecognitionEvent
  data object Ended : RecognitionEvent
}

private class EventListener(private val events: Channel<RecognitionEvent>) : RecognitionListener {
  override fun onPartialResults(partialResults: Bundle) {
    events.trySend(RecognitionEvent.Partial(firstResult(partialResults)))
  }

  override fun onSegmentResults(segmentResults: Bundle) {
    events.trySend(RecognitionEvent.Segment(firstResult(segmentResults)))
  }

  // An unsegmented session (some services ignore the segmented extra) ends with one final result.
  override fun onResults(results: Bundle) {
    events.trySend(RecognitionEvent.Segment(firstResult(results)))
    events.trySend(RecognitionEvent.Ended)
  }

  override fun onEndOfSegmentedSession() {
    events.trySend(RecognitionEvent.Ended)
  }

  override fun onError(error: Int) {
    // No speech in the whole recording is an empty transcript, not a failure.
    val event = if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
      RecognitionEvent.Ended
    } else {
      RecognitionEvent.Failed(error)
    }
    events.trySend(event)
  }

  override fun onReadyForSpeech(params: Bundle?) = Unit
  override fun onBeginningOfSpeech() = Unit
  override fun onRmsChanged(rmsdB: Float) = Unit
  override fun onBufferReceived(buffer: ByteArray?) = Unit
  override fun onEndOfSpeech() = Unit
  override fun onEvent(eventType: Int, params: Bundle?) = Unit
}

private fun firstResult(bundle: Bundle): String =
  bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
