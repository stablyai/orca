package expo.modules.orcareadaloud

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sin

/** The chime before an auto-read message: two soft notes, synthesized so no sound file ships. */
internal object ReadAloudChime {
  private const val SAMPLE_RATE = 24_000
  private const val LENGTH_MS = 440
  private const val VOLUME = 0.3
  // (frequency in Hz, start in ms, length in ms): G5, then D6.
  private val NOTES = listOf(Triple(784.0, 0, 190), Triple(1174.7, 110, 330))

  /** How long to let the track play before it is released. */
  const val PLAY_MS = LENGTH_MS + 80L

  private val samples: ShortArray by lazy { synthesize() }

  private fun synthesize(): ShortArray {
    val total = SAMPLE_RATE * LENGTH_MS / 1000
    val mix = DoubleArray(total)
    for ((frequency, startMs, lengthMs) in NOTES) {
      val start = SAMPLE_RATE * startMs / 1000
      val length = SAMPLE_RATE * lengthMs / 1000
      for (i in 0 until min(length, total - start)) {
        val t = i.toDouble() / SAMPLE_RATE
        // A 6 ms attack and a 20 ms fade at the cut, so neither end clicks.
        val edges = min(1.0, i / (0.006 * SAMPLE_RATE)) * min(1.0, (length - i) / (0.02 * SAMPLE_RATE))
        val tone = sin(2 * PI * frequency * t) + 0.25 * exp(-t * 20) * sin(4 * PI * frequency * t)
        mix[start + i] += VOLUME * edges * exp(-t * 9) * tone
      }
    }
    return ShortArray(total) { (mix[it].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).toInt().toShort() }
  }

  /** A loaded track ready to play, or null when the system refused one. */
  fun track(attributes: AudioAttributes): AudioTrack? = load(attributes, samples)

  /** A tenth of a second of silence, see [ReadAloudMediaSession]. */
  fun silence(attributes: AudioAttributes): AudioTrack? = load(attributes, ShortArray(SAMPLE_RATE / 10))

  private fun load(attributes: AudioAttributes, pcm: ShortArray): AudioTrack? {
    val track = try {
      AudioTrack.Builder()
        .setAudioAttributes(attributes)
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        )
        .setTransferMode(AudioTrack.MODE_STATIC)
        .setBufferSizeInBytes(pcm.size * 2)
        .build()
    } catch (_: Exception) {
      return null
    }
    if (track.write(pcm, 0, pcm.size) != pcm.size || track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      return null
    }
    return track
  }
}
