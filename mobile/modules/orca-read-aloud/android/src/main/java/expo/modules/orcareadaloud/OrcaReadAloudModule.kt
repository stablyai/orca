package expo.modules.orcareadaloud

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Starts and stops [ReadAloudService], forwards its ticks to JS, and speaks through [ReadAloudSpeech]. */
class OrcaReadAloudModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaReadAloud")

    Events("onTick", "onSpeech", "onAutoReadToggle", "onReaderControl")

    // Wired at creation rather than on first observer: a module instance exists only while the
    // app's JS runs, which is exactly what the sticky service checks the ticker listener for.
    OnCreate {
      ReadAloudTicker.listener = { sendEvent("onTick", emptyMap<String, Any>()) }
      ReadAloudSpeech.listener = { event, id, message ->
        sendEvent("onSpeech", mapOf("event" to event, "id" to id, "message" to message))
      }
      ReadAloudControls.listener = { control ->
        if (control == ReadAloudControls.TOGGLE_AUTO_READ) {
          sendEvent("onAutoReadToggle", emptyMap<String, Any>())
        } else {
          sendEvent("onReaderControl", mapOf("action" to control))
        }
      }
      appContext.reactContext?.let { ReadAloudOutput.watch(it) }
    }

    /** False when Android refused the service, e.g. a start attempted from the background. */
    Function("start") { tickMs: Double ->
      val context = appContext.reactContext ?: return@Function false
      ReadAloudService.start(context, tickMs.toLong())
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      ReadAloudService.stop(context)
    }

    Function("isRunning") { ReadAloudService.isRunning }

    /** Queues one utterance; its progress comes back as `onSpeech` events carrying the id. */
    Function("speak") { id: String, text: String, language: String? ->
      val context = appContext.reactContext ?: return@Function false
      ReadAloudSpeech.speak(context, id, text, language)
      true
    }

    /** The phone's guess at each text's language, so a sentence can be read in its own voice. */
    Function("detectLanguages") { texts: List<String> ->
      val context = appContext.reactContext ?: return@Function texts.map { null }
      ReadAloudLanguage.detect(context, texts)
    }

    /** Queues the chime before an auto-read message, reported by id like an utterance. */
    Function("chime") { id: String ->
      val context = appContext.reactContext ?: return@Function false
      ReadAloudSpeech.chime(context, id)
      true
    }

    Function("spokenOffset") { id: String -> ReadAloudSpeech.spokenOffset(id) }

    Function("stopSpeech") {
      ReadAloudSpeech.stop()
    }

    /** `rate` 1 = normal; null rate or voice = the phone's text-to-speech setting. */
    Function("getSpeechOptions") {
      val context = appContext.reactContext ?: return@Function null
      val (rate, voice) = ReadAloudSpeech.options(context)
      mapOf(
        "rate" to rate?.toDouble(),
        "voice" to voice,
        "phoneRate" to ReadAloudSpeech.systemRate(context).toDouble(),
        "language" to ReadAloudSpeech.language(context)
      )
    }

    Function("setSpeechOptions") { rate: Double?, voice: String? ->
      val context = appContext.reactContext ?: return@Function false
      ReadAloudSpeech.setOptions(context, rate?.toFloat(), voice)
      true
    }

    /** Null when the engine did not start. */
    AsyncFunction("getVoices") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.resolve(null)
      ReadAloudSpeech.withEngine(context) { engine ->
        promise.resolve(ReadAloudSpeech.describeVoices(engine))
      }
    }

    Function("openTtsSettings") {
      val context = appContext.reactContext ?: return@Function false
      listOf("com.android.settings.TTS_SETTINGS", Settings.ACTION_ACCESSIBILITY_SETTINGS).any { action ->
        try {
          context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          true
        } catch (_: Exception) {
          false
        }
      }
    }

    /** What the notification's auto-read button shows; the pause itself lives in JS. */
    Function("setAutoReadPaused") { paused: Boolean ->
      ReadAloudService.showAutoReadPaused(paused)
    }

    /** The reader's state ("idle", "reading", "paused") for the notification and the headset. */
    Function("setReaderState") { state: String, title: String?, status: String?, canRepeat: Boolean,
      canPrevious: Boolean, canNext: Boolean ->
      ReadAloudService.showReader(state, status, canRepeat, canPrevious, canNext)
      appContext.reactContext?.let {
        // Also here, in case there was no context yet when the module was created.
        ReadAloudOutput.watch(it)
        ReadAloudMediaSession.update(it, state, title, canPrevious, canNext)
      }
    }

    /** Whether sound goes to headphones, a car or the like rather than the phone's speaker. */
    Function("isPrivateOutput") {
      val context = appContext.reactContext ?: return@Function true
      ReadAloudOutput.isPrivate(context)
    }

    OnDestroy {
      ReadAloudTicker.listener = null
      ReadAloudSpeech.listener = null
      ReadAloudControls.listener = null
      ReadAloudOutput.unwatch()
      ReadAloudMediaSession.end()
    }
  }
}
