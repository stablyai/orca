package expo.modules.orcareadaloud

import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper

/**
 * Hands headset and steering-wheel buttons to JS via [ReadAloudControls] while something is read;
 * released when idle or long paused, so the buttons go back to the music app.
 */
internal object ReadAloudMediaSession {
  private const val RELEASE_PAUSED_AFTER_MS = 10 * 60_000L
  private const val ACTIONS = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
    PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP

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
  fun update(context: Context, state: String, title: String?) {
    val app = context.applicationContext
    handler.post { apply(app, state, title) }
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

  private fun apply(context: Context, state: String, title: String?) {
    handler.removeCallbacks(releasePaused)
    if (state != "reading" && state != "paused") {
      release()
      return
    }
    val existing = session
    val media = existing ?: MediaSession(context, "OrcaReadAloud").also {
      it.setCallback(callback, handler)
      session = it
    }
    val wasPlaying = existing?.controller?.playbackState?.state == PlaybackState.STATE_PLAYING
    val playing = state == "reading"
    media.setPlaybackState(
      PlaybackState.Builder()
        .setActions(ACTIONS)
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
