package expo.modules.twowayaudio

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioPlaybackGateTest {
    @Test
    fun waitsForResumeWithoutCancellingPlayback() {
        val gate = AudioPlaybackGate()
        val waiting = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()

        assertTrue(gate.startIfIdle())
        gate.pause()
        val result = executor.submit<Boolean> {
            waiting.countDown()
            gate.awaitWritable()
        }

        assertTrue(waiting.await(1, TimeUnit.SECONDS))
        assertFalse(result.isDone)
        gate.resume()
        assertTrue(result.get(1, TimeUnit.SECONDS))
        gate.cancel()
        assertFalse(gate.isActive())
        executor.shutdownNow()
    }
}
