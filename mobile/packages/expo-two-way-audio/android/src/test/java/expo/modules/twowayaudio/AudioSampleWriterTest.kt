package expo.modules.twowayaudio

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioSampleWriterTest {
    @Test
    fun drainsPartialWritesWithoutDroppingBytes() {
        val writes = mutableListOf<Pair<Int, Int>>()
        val reported = mutableListOf<Int>()

        val total = writeAudioSampleFully(
            sample = ByteArray(10),
            isActive = { true },
            write = { offset, length ->
                writes += offset to length
                minOf(3, length)
            },
            onWrite = reported::add
        )

        assertEquals(10, total)
        assertEquals(listOf(0 to 10, 3 to 7, 6 to 4, 9 to 1), writes)
        assertEquals(listOf(3, 3, 3, 1), reported)
    }

    @Test
    fun stopsAtPlaybackCancellation() {
        var active = true
        var calls = 0

        val total = writeAudioSampleFully(
            sample = ByteArray(10),
            isActive = { active },
            write = { _, _ ->
                calls += 1
                4
            },
            onWrite = { active = false }
        )

        assertEquals(4, total)
        assertEquals(1, calls)
    }

    @Test
    fun retriesZeroWriteAfterPlaybackResumes() {
        var calls = 0
        var retries = 0
        val reported = mutableListOf<Int>()

        val total = writeAudioSampleFully(
            sample = ByteArray(10),
            isActive = { true },
            retryNoProgress = {
                retries += 1
                true
            },
            write = { _, length ->
                calls += 1
                if (calls == 2) 0 else minOf(4, length)
            },
            onWrite = reported::add
        )

        assertEquals(10, total)
        assertEquals(1, retries)
        assertEquals(listOf(4, 4, 2), reported)
    }

    @Test
    fun rejectsNonProgressAndOversizedResults() {
        for (result in listOf(0, -1, 11)) {
            var reported = 0
            val total = writeAudioSampleFully(
                sample = ByteArray(10),
                isActive = { true },
                write = { _, _ -> result },
                onWrite = { reported += it }
            )

            assertEquals(0, total)
            assertEquals(0, reported)
        }
    }
}
