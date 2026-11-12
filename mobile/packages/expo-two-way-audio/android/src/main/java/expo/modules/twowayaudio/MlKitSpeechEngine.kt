package expo.modules.twowayaudio

import androidx.annotation.RequiresApi
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import com.google.mlkit.genai.speechrecognition.speechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.speechRecognizerRequest
import java.util.Locale
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ML Kit GenAI speech recognition: Advanced (Gemini Nano) where the device has it, otherwise Basic,
// Google's on-device model on Android 12+. AICore owns the models, so nothing ships in the APK.
@RequiresApi(31)
internal class MlKitSpeechEngine : OnDeviceSpeechEngine {
  override suspend fun resolve(candidates: List<Locale>): SpeechTarget? {
    for (locale in candidates) {
      var pending: SpeechTarget? = null
      for (mode in MODES) {
        when (status(locale, mode)) {
          FeatureStatus.AVAILABLE -> return SpeechTarget(SpeechStatus.READY, locale, mode)
          FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING ->
            pending = pending ?: SpeechTarget(SpeechStatus.NEEDS_DOWNLOAD, locale, mode)
        }
      }
      if (pending != null) return pending
    }
    return null
  }

  override suspend fun download(target: SpeechTarget, onProgress: (Double) -> Unit): Boolean =
    client(target.locale, target.variant).use { recognizer ->
      var total = 0L
      val outcome = recognizer.download().first { status ->
        when (status) {
          is DownloadStatus.DownloadStarted -> total = status.bytesToDownload
          is DownloadStatus.DownloadProgress ->
            if (total > 0) onProgress((status.totalBytesDownloaded.toDouble() / total).coerceIn(0.0, 1.0))
          else -> Unit
        }
        status is DownloadStatus.DownloadCompleted || status is DownloadStatus.DownloadFailed
      }
      outcome is DownloadStatus.DownloadCompleted && checkStatus(recognizer) == FeatureStatus.AVAILABLE
    }

  override suspend fun recognize(
    target: SpeechTarget,
    audio: PcmQueue,
    onText: (String, String) -> Unit
  ): String = client(target.locale, target.variant).use { recognizer ->
    PacedPcmPipe().use { pipe ->
      val request = speechRecognizerRequest { audioSource = AudioSource.fromPfd(pipe.readEnd) }
      try {
        coroutineScope {
          val writer = launch { pipe.pump(audio) }
          val committed = StringBuilder()
          var tentative = ""
          var completed = false
          recognizer.startRecognition(request).collect { response ->
            when (response) {
              // The SDK supplies the separators between final utterances.
              is SpeechRecognizerResponse.FinalTextResponse -> {
                committed.append(response.text)
                tentative = ""
              }
              is SpeechRecognizerResponse.PartialTextResponse -> tentative = response.text
              is SpeechRecognizerResponse.ErrorResponse -> throw response.e
              is SpeechRecognizerResponse.CompletedResponse -> completed = true
              else -> Unit
            }
            onText(committed.toString(), tentative)
          }
          if (!completed || writer.isActive) {
            writer.cancel()
            throw SpeechFailure("failed", "Speech recognition ended before the recording did.")
          }
          writer.join()
          // Some sessions complete with a trailing partial instead of another final result.
          committed.append(tentative).toString().trim()
        }
      } finally {
        withContext(NonCancellable) { runCatching { recognizer.stopRecognition() } }
      }
    }
  }

  override fun failureCode(error: Throwable): String = when (error) {
    is GenAiException -> when (error.errorCode) {
      GenAiException.ErrorCode.BUSY -> "busy"
      GenAiException.ErrorCode.NOT_AVAILABLE,
      GenAiException.ErrorCode.AICORE_INCOMPATIBLE,
      GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> "unsupported"
      else -> "failed"
    }
    else -> "failed"
  }

  private suspend fun status(locale: Locale, mode: Int): Int = client(locale, mode).use { checkStatus(it) }

  // A probe that throws means this mode can't run here; the next mode or the computer takes over.
  private suspend fun checkStatus(recognizer: SpeechRecognizer): Int = try {
    recognizer.checkStatus()
  } catch (_: GenAiException) {
    FeatureStatus.UNAVAILABLE
  }

  private fun client(speechLocale: Locale, mode: Int): SpeechRecognizer = SpeechRecognition.getClient(
    speechRecognizerOptions {
      locale = speechLocale
      preferredMode = mode
    }
  )

  private companion object {
    val MODES = listOf(
      SpeechRecognizerOptions.Mode.MODE_ADVANCED,
      SpeechRecognizerOptions.Mode.MODE_BASIC
    )
  }
}
