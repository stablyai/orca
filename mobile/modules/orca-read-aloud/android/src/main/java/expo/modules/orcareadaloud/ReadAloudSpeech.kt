package expo.modules.orcareadaloud

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale

/** The phone's TTS with audio focus and navigation attributes, so music ducks and cars play it. */
object ReadAloudSpeech : UtteranceProgressListener() {
  // Per utterance id: "start", "done", "error", "waiting" (for the mic). With no id: "interrupted",
  // "held", "regained"; [ReadAloudOutput] adds "noisy" and "private-output".
  @Volatile var listener: ((String, String, String?) -> Unit)? = null

  // Focus outlives the queue this long, so music does not swell back between pieces of a reply.
  private const val FOCUS_GRACE_MS = 1500L
  // A refused focus request registers no listener, so only asking again shows when a call ended.
  private const val FOCUS_RETRY_MS = 3000L
  private const val ENGINE_FAILED = "text-to-speech engine did not start"
  private const val PREFS = "orca-read-aloud"
  private const val PREF_RATE = "rate"
  private const val PREF_VOICE = "voice"
  private const val PREF_LANGUAGE = "language"
  // A dictation longer than this is unlikely; past it the held reading goes ahead anyway.
  private const val MIC_WAIT_LIMIT_MS = 120_000L
  // What a person talks into; not the assistant's hotword listener, which some phones keep open.
  private val SPOKEN_SOURCES = setOf(
    MediaRecorder.AudioSource.MIC,
    MediaRecorder.AudioSource.CAMCORDER,
    MediaRecorder.AudioSource.VOICE_RECOGNITION,
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,
    MediaRecorder.AudioSource.UNPROCESSED,
    MediaRecorder.AudioSource.VOICE_PERFORMANCE
  )

  // Navigation guidance (what Google Maps announces with) reaches car head units over Bluetooth
  // and makes the system duck other audio while it plays.
  internal val attributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private var appContext: Context? = null
  private var tts: TextToSpeech? = null
  private var ready = false
  // With no usable engine, onInit runs inside the TextToSpeech constructor, before `tts` is set.
  private var startingEngine = false
  private var startStatus: Int? = null
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var legacyFocusHeld = false
  // Ids, not a count: a stopped utterance's late onStop must not end the one that replaced it.
  private val active = mutableSetOf<String>()
  private val pending = mutableListOf<Pair<String, String>>()
  // An engine whose service died (an update, a Bluetooth switch) refuses every utterance, so after
  // a failure it is rebuilt once the queue is empty.
  private var rebuildEngine = false
  private val handler = Handler(Looper.getMainLooper())
  private val releaseFocus = Runnable {
    synchronized(ReadAloudSpeech) { if (active.isEmpty()) abandonFocus() }
  }
  private val focusRetry = Runnable { retryFocus() }
  // (id, text); null text is the chime.
  private val heldForMic = mutableListOf<Pair<String, String?>>()
  private var chimeTrack: AudioTrack? = null
  private var chimeId: String? = null
  private var chimeFinished: Runnable? = null
  private val whenReady = mutableListOf<(TextToSpeech?) -> Unit>()
  // Whether this engine was given our rate or voice, so going back to the phone's setting resets it.
  private var rateApplied = false
  private var voiceApplied = false
  // The engine takes the voice with each queued utterance, so after one in another language the
  // reading voice is set back right away.
  private val languages = mutableMapOf<String, String>()
  private val languageVoices = mutableMapOf<String, Voice?>()
  private var readingVoice: Voice? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private val micWaitLimit = Runnable { synchronized(ReadAloudSpeech) { releaseHeld() } }
  // Set while a call or dictation has the audio: nothing is spoken, and its end is reported.
  private var heldByInterruption = false
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        stop()
        listener?.invoke("interrupted", "", "another app took the audio")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        holdForInterruption()
        listener?.invoke("held", "", "a call or dictation took the audio")
      }
      AudioManager.AUDIOFOCUS_GAIN -> if (endInterruption()) reportRegained()
    }
  }

  /** `language`: a primary subtag to read this one in, null for the reading voice. */
  @Synchronized
  fun speak(context: Context, id: String, text: String, language: String?) {
    if (language != null) languages[id] = language
    play(context, id, text)
  }

  /** The chime auto-read can play before a message, reported like an utterance. */
  @Synchronized
  fun chime(context: Context, id: String) = play(context, id, null)

  private fun play(context: Context, id: String, text: String?) {
    appContext = context.applicationContext
    if (audioManager == null) {
      audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }
    // Never talk over dictation or a call; queue behind anything already held to keep the order.
    if (heldForMic.isNotEmpty() || micBusy(context)) {
      heldForMic.add(id to text)
      watchMic()
      listener?.invoke("waiting", id, null)
      return
    }
    playNow(id, text)
  }

  private fun playNow(id: String, text: String?) {
    if (text == null) playChime(id) else speakNow(id, text)
  }

  // Played in-process rather than as a TTS earcon: the engine runs in another app, which may not
  // be allowed to read this app's resources.
  private fun playChime(id: String) {
    // A chime cut short by this one still reports, or its id would keep the focus forever.
    val replaced = chimeId
    endChime()
    if (replaced != null && finish(replaced)) listener?.invoke("done", replaced, null)
    handler.removeCallbacks(releaseFocus)
    if (!requestFocus()) {
      holdForFocus()
      return
    }
    active.add(id)
    val track = ReadAloudChime.track(attributes)
    val started = track != null && runCatching { track.play() }.isSuccess
    if (!started) {
      track?.release()
      // Not the engine's failure, so no rebuild.
      if (finish(id)) listener?.invoke("error", id, "the chime could not play")
      return
    }
    chimeTrack = track
    chimeId = id
    val finished = Runnable {
      val done = synchronized(ReadAloudSpeech) {
        endChime()
        finish(id)
      }
      if (done) listener?.invoke("done", id, null)
    }
    chimeFinished = finished
    listener?.invoke("start", id, null)
    handler.postDelayed(finished, ReadAloudChime.PLAY_MS)
  }

  private fun endChime() {
    chimeFinished?.let { handler.removeCallbacks(it) }
    chimeFinished = null
    chimeId = null
    chimeTrack?.let { track ->
      runCatching { track.stop() }
      track.release()
    }
    chimeTrack = null
  }

  private fun speakNow(id: String, text: String) {
    val context = appContext ?: return
    if (!ensureEngine(context)) {
      languages.remove(id)
      listener?.invoke("error", id, ENGINE_FAILED)
      return
    }
    if (!ready) {
      pending.add(id to text)
      return
    }
    enqueue(id, text)
  }

  /** False when no engine could start; the next call tries again. */
  private fun ensureEngine(context: Context): Boolean {
    if (tts != null) return true
    audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    startingEngine = true
    startStatus = null
    val engine = runCatching { TextToSpeech(context) { status -> onInit(status) } }.getOrNull()
    startingEngine = false
    tts = engine
    val early = if (engine == null) TextToSpeech.ERROR else startStatus
    if (early != null) onInit(early)
    return tts != null
  }

  /** Calls back with the started engine, or with null when it could not start. */
  @Synchronized
  fun withEngine(context: Context, callback: (TextToSpeech?) -> Unit) {
    val app = context.applicationContext
    appContext = app
    when {
      !ensureEngine(app) -> callback(null)
      ready -> callback(tts)
      else -> whenReady.add(callback)
    }
  }

  /** The rate (1 = normal) and voice name chosen in Orca; null means the phone's setting. */
  fun options(context: Context): Pair<Float?, String?> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.getFloat(PREF_RATE, 0f).takeIf { it > 0f } to prefs.getString(PREF_VOICE, null)
  }

  /** Kept natively, so the first reading after a restart already uses them. */
  @Synchronized
  fun setOptions(context: Context, rate: Float?, voice: String?) {
    appContext = context.applicationContext
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
      if (rate == null) remove(PREF_RATE) else putFloat(PREF_RATE, rate)
      if (voice == null) remove(PREF_VOICE) else putString(PREF_VOICE, voice)
    }.apply()
    if (ready) applyOptions()
  }

  /** Installed voices, the engine's default one, and the language it reads in by default. */
  fun describeVoices(engine: TextToSpeech?): Map<String, Any?>? {
    engine ?: return null
    // Some engines throw from these instead of returning null.
    val voices = runCatching { engine.voices }.getOrNull().orEmpty()
    val default = runCatching { engine.defaultVoice }.getOrNull()
    // The phone's voice may have changed in its settings since the engine started.
    if (!voiceApplied) rememberLanguage(default?.locale)
    return mapOf(
      "voices" to voices.map { voice ->
        mapOf(
          "name" to voice.name,
          "language" to voice.locale.toLanguageTag(),
          "needsInternet" to voice.isNetworkConnectionRequired,
          "installed" to !voice.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
        )
      },
      "defaultVoice" to default?.name,
      "language" to (default?.locale ?: Locale.getDefault()).toLanguageTag()
    )
  }

  /** Reaches the next piece; the one playing keeps what it was queued with. */
  private fun applyOptions() {
    val engine = tts ?: return
    val context = appContext ?: return
    val (rate, voiceName) = options(context)
    if (rate != null || rateApplied) {
      engine.setSpeechRate(rate ?: systemRate(context))
      rateApplied = rate != null
    }
    val voice = voiceName?.let { name ->
      runCatching { engine.voices }.getOrNull()?.firstOrNull { it.name == name }
    }
    if (voice != null) {
      engine.setVoice(voice)
      voiceApplied = true
    } else if (voiceApplied) {
      runCatching { engine.defaultVoice }.getOrNull()?.let { engine.setVoice(it) }
      voiceApplied = false
    }
    readingVoice = voice ?: runCatching { engine.defaultVoice }.getOrNull()
    rememberLanguage(voice?.locale ?: defaultLocale(engine))
  }

  // An installed offline voice for `language` (the engine's pick, else the phone's region, else
  // any); null when there is none or it is the reading voice's language.
  private fun voiceFor(language: String): Voice? {
    val engine = tts ?: return null
    // Without a voice to go back to, a switch would stick to every utterance after it.
    val reading = readingVoice ?: return null
    val wanted = Locale(language).language
    if (reading.locale.language == wanted) return null
    if (languageVoices.containsKey(wanted)) return languageVoices[wanted]
    val offline = runCatching { engine.voices }.getOrNull().orEmpty().filter { voice ->
      voice.locale.language == wanted && !voice.isNetworkConnectionRequired &&
        !voice.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
    }
    val enginePick = runCatching {
      if (engine.setLanguage(Locale(wanted)) >= TextToSpeech.LANG_AVAILABLE) engine.voice else null
    }.getOrNull()
    restoreReadingVoice()
    val region = Locale.getDefault().country
    val voice = offline.firstOrNull { it.name == enginePick?.name }
      ?: offline.sortedWith(compareBy({ it.locale.country != region }, { it.name })).firstOrNull()
    languageVoices[wanted] = voice
    return voice
  }

  private fun restoreReadingVoice() {
    val voice = readingVoice ?: return
    runCatching { tts?.setVoice(voice) }
    // Now set explicitly, so going back to the phone's voice resets it.
    voiceApplied = true
  }

  @Suppress("DEPRECATION")
  private fun defaultLocale(engine: TextToSpeech): Locale? =
    runCatching { engine.defaultVoice?.locale ?: engine.defaultLanguage }.getOrNull()

  // Persisted so the reader's own words (a skipped code block, an agent waiting) match the voice's
  // language even before the engine starts again after a restart.
  private fun rememberLanguage(locale: Locale?) {
    val context = appContext ?: return
    val tag = locale?.toLanguageTag()?.takeIf { it != "und" } ?: return
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getString(PREF_LANGUAGE, null) != tag) {
      prefs.edit().putString(PREF_LANGUAGE, tag).apply()
    }
  }

  /** The language the reader last read in; null before its engine first started. */
  fun language(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_LANGUAGE, null)

  // What the engine uses when it is given no rate (100 = normal).
  fun systemRate(context: Context): Float =
    Settings.Secure.getInt(context.contentResolver, Settings.Secure.TTS_DEFAULT_RATE, 100) / 100f

  @Synchronized
  fun stop() {
    silence()
    heldByInterruption = false
    abandonFocus()
  }

  /** Like [stop], but the focus request stays, so its return after a call is reported. */
  @Synchronized
  private fun holdForInterruption() {
    silence()
    heldByInterruption = true
  }

  @Synchronized
  private fun endInterruption(): Boolean {
    val held = heldByInterruption
    heldByInterruption = false
    return held
  }

  // Focus refused or delayed by a call: held like a transient loss rather than spoken into the call.
  private fun holdForFocus() {
    holdForInterruption()
    listener?.invoke("held", "", "a call or dictation has the audio")
    if (!focusRegistered()) handler.postDelayed(focusRetry, FOCUS_RETRY_MS)
  }

  private fun retryFocus() {
    val regained = synchronized(this) {
      // A registered request hears of the grant through focusListener instead.
      if (!heldByInterruption || focusRegistered()) return
      requestFocus().also { granted ->
        if (!granted && !focusRegistered()) handler.postDelayed(focusRetry, FOCUS_RETRY_MS)
      }
    }
    if (regained) reportRegained()
  }

  // The reader resumes on "regained"; should it not, the focus goes back instead of ducking music.
  private fun reportRegained() {
    handler.removeCallbacks(releaseFocus)
    handler.postDelayed(releaseFocus, FOCUS_GRACE_MS)
    listener?.invoke("regained", "", null)
  }

  private fun silence() {
    pending.clear()
    languages.clear()
    heldForMic.clear()
    stopWatchingMic()
    // Forgotten first, so the onStop callbacks this stop causes read as asked for.
    active.clear()
    tts?.stop()
    endChime()
    handler.removeCallbacks(releaseFocus)
    handler.removeCallbacks(focusRetry)
  }

  @Synchronized
  private fun onInit(status: Int) {
    // Handled by ensureEngine once the constructor has returned and `tts` is this engine.
    if (startingEngine) {
      startStatus = status
      return
    }
    ready = status == TextToSpeech.SUCCESS
    val queued = pending.toList()
    pending.clear()
    val waiting = whenReady.toList()
    whenReady.clear()
    if (!ready) {
      queued.forEach { (id, _) ->
        languages.remove(id)
        listener?.invoke("error", id, ENGINE_FAILED)
      }
      runCatching { tts?.shutdown() }
      tts = null
      waiting.forEach { it(null) }
      return
    }
    tts?.setAudioAttributes(attributes)
    tts?.setOnUtteranceProgressListener(this)
    // A new engine starts from the phone's settings.
    rateApplied = false
    voiceApplied = false
    languageVoices.clear()
    applyOptions()
    waiting.forEach { it(tts) }
    queued.forEach { (id, text) -> enqueue(id, text) }
  }

  private fun enqueue(id: String, text: String) {
    handler.removeCallbacks(releaseFocus)
    if (!requestFocus()) {
      holdForFocus()
      return
    }
    active.add(id)
    val engine = tts
    val voice = languages.remove(id)?.let { voiceFor(it) }
    voice?.let { runCatching { engine?.setVoice(it) } }
    val result = engine?.speak(text, TextToSpeech.QUEUE_ADD, null, id) ?: TextToSpeech.ERROR
    if (voice != null) restoreReadingVoice()
    if (result != TextToSpeech.SUCCESS) {
      fail(id, "text-to-speech refused the text")
    }
  }

  // The engine has no pause: Pause stops it, and Resume goes on from the word it was reading.
  @Volatile private var spokenWord: Pair<String, Int>? = null

  override fun onRangeStart(utteranceId: String, start: Int, end: Int, frame: Int) {
    spokenWord = utteranceId to start
  }

  fun spokenOffset(id: String): Int = spokenWord?.takeIf { it.first == id }?.second ?: 0

  override fun onStart(utteranceId: String) {
    listener?.invoke("start", utteranceId, null)
  }

  override fun onDone(utteranceId: String) {
    if (finish(utteranceId)) {
      listener?.invoke("done", utteranceId, null)
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onError(utteranceId: String) {
    fail(utteranceId, "text-to-speech failed")
  }

  override fun onError(utteranceId: String, errorCode: Int) {
    fail(utteranceId, "text-to-speech failed ($errorCode)")
  }

  override fun onStop(utteranceId: String, interrupted: Boolean) {
    // stop() already forgot its ids, so one still active was cut off by something else, and the
    // reader would otherwise wait for it forever.
    fail(utteranceId, "text-to-speech was stopped by the system")
  }

  /** Finished before the reader hears of it, so a retry it sends lands on a rebuilt engine. */
  private fun fail(id: String, message: String) {
    val failed = synchronized(this) {
      // Ids a deliberate stop forgot are not failures, so their onStop costs no rebuild.
      if (id in active) rebuildEngine = true
      finish(id)
    }
    if (failed) {
      listener?.invoke("error", id, message)
    }
  }

  /** False when the id already finished or was stopped on purpose. */
  @Synchronized
  private fun finish(id: String): Boolean {
    if (!active.remove(id)) {
      return false
    }
    if (active.isEmpty()) {
      handler.removeCallbacks(releaseFocus)
      handler.postDelayed(releaseFocus, FOCUS_GRACE_MS)
      if (rebuildEngine) {
        rebuildEngine = false
        tts?.shutdown()
        tts = null
        ready = false
      }
    }
    return true
  }

  private fun micBusy(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return manager.activeRecordingConfigurations.any { it.clientAudioSource in SPOKEN_SOURCES }
  }

  private fun watchMic() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || recordingCallback != null) return
    val context = appContext ?: return
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val callback = object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
        synchronized(ReadAloudSpeech) {
          if (!micBusy(context)) releaseHeld()
        }
      }
    }
    manager.registerAudioRecordingCallback(callback, handler)
    recordingCallback = callback
    handler.postDelayed(micWaitLimit, MIC_WAIT_LIMIT_MS)
  }

  private fun stopWatchingMic() {
    handler.removeCallbacks(micWaitLimit)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      val manager = appContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      recordingCallback?.let { manager?.unregisterAudioRecordingCallback(it) }
    }
    recordingCallback = null
  }

  private fun releaseHeld() {
    stopWatchingMic()
    val held = heldForMic.toList()
    heldForMic.clear()
    held.forEach { (id, text) -> playNow(id, text) }
  }

  // Whether the audio is ours; a request delayed by a call stays registered and is granted later.
  private fun requestFocus(): Boolean {
    if (focusRegistered()) return !heldByInterruption
    val manager = audioManager ?: return true
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .setAcceptsDelayedFocusGain(true)
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build()
      val result = manager.requestAudioFocus(request)
      if (result != AudioManager.AUDIOFOCUS_REQUEST_FAILED) focusRequest = request
      result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      @Suppress("DEPRECATION")
      val result = manager.requestAudioFocus(
        focusListener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
      )
      legacyFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      legacyFocusHeld
    }
    if (granted) {
      heldByInterruption = false
      handler.removeCallbacks(focusRetry)
    }
    return granted
  }

  private fun focusRegistered(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focusRequest != null else legacyFocusHeld

  private fun abandonFocus() {
    val manager = audioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { manager.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else if (legacyFocusHeld) {
      @Suppress("DEPRECATION")
      manager.abandonAudioFocus(focusListener)
      legacyFocusHeld = false
    }
  }
}
