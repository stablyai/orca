package expo.modules.twowayaudio

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.Closeable
import kotlin.time.TimeSource
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout

// A pipe a streaming recognizer reads PCM from. Streaming sources must be written at real time:
// writing faster overflows the recognizer's buffer, so a backlog (audio queued while it warmed up) is
// paced out rather than burst.
internal class PacedPcmPipe : Closeable {
  private val ends = ParcelFileDescriptor.createPipe()
  val readEnd: ParcelFileDescriptor get() = ends[0]
  private val writeEnd = ends[1]

  init {
    // Non-blocking so a recognizer that stops reading can't wedge the writer past cancellation.
    Os.fcntlInt(writeEnd.fileDescriptor, OsConstants.F_SETFL, OsConstants.O_NONBLOCK)
  }

  suspend fun pump(audio: PcmQueue) {
    val started = TimeSource.Monotonic.markNow()
    var writtenBytes = 0L
    while (true) {
      val chunk = audio.take() ?: break
      val aheadMs = writtenBytes / SPEECH_BYTES_PER_MS - started.elapsedNow().inWholeMilliseconds
      if (aheadMs > 0) delay(aheadMs)
      write(chunk)
      writtenBytes += chunk.size
    }
    writeEnd.close()
  }

  private suspend fun write(chunk: ByteArray) {
    try {
      withTimeout(STALL_TIMEOUT_MS) {
        var offset = 0
        while (offset < chunk.size) {
          try {
            offset += Os.write(writeEnd.fileDescriptor, chunk, offset, chunk.size - offset)
          } catch (error: ErrnoException) {
            if (error.errno != OsConstants.EAGAIN) {
              throw SpeechFailure("failed", "The recognizer stopped reading audio.", error)
            }
            delay(10)
          }
        }
      }
    } catch (error: TimeoutCancellationException) {
      throw SpeechFailure("failed", "The recognizer stopped reading audio.", error)
    }
  }

  override fun close() {
    runCatching { writeEnd.close() }
    runCatching { readEnd.close() }
  }

  private companion object {
    const val STALL_TIMEOUT_MS = 5_000L
  }
}
