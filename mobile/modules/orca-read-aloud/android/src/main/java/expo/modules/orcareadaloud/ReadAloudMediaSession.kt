package expo.modules.orcareadaloud

import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper

// Headset and steering-wheel buttons go to JS while something is read; released when idle or long
// paused, so they go back to the music app.
internal object ReadAloudMediaSession {
  private const val RELEASE_PAUSED_AFTER_MS = 10 * 60_000L
  private const val ACTIONS = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP

  private val handler = Handler(Looper.getMainLooper())
  private var session: MediaSession? = null
  private val releasePaused = Runnable { release() }

  private val callback = object : MediaSession.Callback() {
    override fun onPlay() = ReadAloudControls.send(ReadAloudControls.PLAY)
    override fun onPause() = ReadAloudControls.send(ReadAloudControls.PAUSE)
    override fun onSkipToNext() = ReadAloudControls.send(ReadAloudControls.NEXT)
    override fun onSkipToPrevious() = ReadAloudControls.send(ReadAloudControls.PREVIOUS)
    override fun onStop() = ReadAloudControls.send(ReadAloudControls.STOP_READING)
  }

  /** `state`: "idle", "reading" or "paused"; `title` is what a car's display shows. */
  fun update(context: Context, state: String, title: String?, previous: Boolean, next: Boolean) {
    val app = context.applicationContext
    // Skips only when there is somewhere to skip to, so a car can grey them out otherwise.
    val actions = ACTIONS or
      (if (previous) PlaybackState.ACTION_SKIP_TO_PREVIOUS else 0L) or
      (if (next) PlaybackState.ACTION_SKIP_TO_NEXT else 0L)
    handler.post { apply(app, state, title, actions) }
  }

  /** Gives the buttons back, e.g. when the app's JS goes away. */
  fun end() {
    handler.post { release() }
  }

  private fun release() {
    handler.removeCallbacks(releasePaused)
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
  }

  private fun apply(context: Context, state: String, title: String?, actions: Long) {
    handler.removeCallbacks(releasePaused)
    if (state != "reading" && state != "paused") {
      release()
      return
    }
    val existing = session
    val media = existing ?: MediaSession(context, "OrcaReadAloud").also {
      // Before Android 8 a session without these flags gets no headset buttons.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        @Suppress("DEPRECATION")
        it.setFlags(
          MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
        )
      }
      it.setCallback(callback, handler)
      session = it
    }
    val wasPlaying = existing?.controller?.playbackState?.state == PlaybackState.STATE_PLAYING
    val playing = state == "reading"
    media.setPlaybackState(
      PlaybackState.Builder()
        .setActions(actions)
        .setState(
          if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          PlaybackState.PLAYBACK_POSITION_UNKNOWN,
          1f
        )
        .build()
    )
    media.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, title ?: "Orca")
        .putString(MediaMetadata.METADATA_KEY_ARTIST, "Orca")
        .build()
    )
    if (!media.isActive) media.isActive = true
    if (playing && !wasPlaying) claimButtons()
    if (!playing) handler.postDelayed(releasePaused, RELEASE_PAUSED_AFTER_MS)
  }

  // Android gives media buttons to the app that last played audio, and TTS plays in the engine's
  // own process, so a moment of silence played here wins them over a music app.
  private fun claimButtons() {
    val track = ReadAloudChime.silence(ReadAloudSpeech.attributes) ?: return
    if (runCatching { track.play() }.isFailure) {
      track.release()
      return
    }
    handler.postDelayed({
      runCatching { track.stop() }
      track.release()
    }, 400)
  }
}
