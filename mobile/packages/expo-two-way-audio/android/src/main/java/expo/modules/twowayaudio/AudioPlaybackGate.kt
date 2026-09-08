package expo.modules.twowayaudio

import java.util.concurrent.atomic.AtomicBoolean

internal class AudioPlaybackGate {
    private val monitor = Object()
    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)

    fun startIfIdle(): Boolean = running.compareAndSet(false, true)

    fun isActive(): Boolean = running.get()

    fun pause() {
        paused.set(true)
    }

    fun resume() {
        paused.set(false)
        wake()
    }

    fun finish() {
        running.set(false)
        wake()
    }

    fun cancel() {
        paused.set(false)
        finish()
    }

    fun awaitWritable(): Boolean = synchronized(monitor) {
        while (running.get() && paused.get()) {
            monitor.wait()
        }
        running.get()
    }

    fun retryNoProgress(): Boolean = synchronized(monitor) {
        if (running.get() && !paused.get()) {
            monitor.wait(NO_PROGRESS_RETRY_DELAY_MS)
        }
        while (running.get() && paused.get()) {
            monitor.wait()
        }
        running.get()
    }

    private fun wake() = synchronized(monitor) {
        monitor.notifyAll()
    }

    private companion object {
        const val NO_PROGRESS_RETRY_DELAY_MS = 10L
    }
}
