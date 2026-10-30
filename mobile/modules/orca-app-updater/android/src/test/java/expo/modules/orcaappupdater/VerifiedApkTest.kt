package expo.modules.orcaappupdater

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InterruptedIOException
import org.junit.Assert.*
import org.junit.Test

class VerifiedApkTest {
  private val bytes = "abc".toByteArray()
  private val digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  @Test fun comparesMarketingVersionsNumerically() {
    assertTrue(isNewerVersion("0.0.58", "0.0.57"))
    assertTrue(isNewerVersion("0.0.10", "0.0.9"))
    assertFalse(isNewerVersion("0.0.58", "0.0.58"))
    assertFalse(isNewerVersion("0.0.57", "0.0.58"))
    assertFalse(isNewerVersion("0.0.58", null))
    assertFalse(isNewerVersion("0.0.59-beta", "0.0.58"))
  }

  @Test fun streamsAndVerifiesWithoutChangingBytes() {
    val output = ByteArrayOutputStream()
    var progress = 0L
    copyVerifiedApk(ByteArrayInputStream(bytes), output, 3, digest, {}) { progress = it }
    assertArrayEquals(bytes, output.toByteArray())
    assertEquals(3L, progress)
  }

  @Test fun rejectsTruncatedOversizedAndChangedDownloads() {
    for ((size, hash) in listOf(4L to digest, 2L to digest, 3L to "0".repeat(64))) {
      assertThrows(IllegalArgumentException::class.java) {
        copyVerifiedApk(ByteArrayInputStream(bytes), ByteArrayOutputStream(), size, hash, {}) {}
      }
    }
  }

  @Test fun cancellationStopsBeforeWriting() {
    val output = ByteArrayOutputStream()
    assertThrows(InterruptedIOException::class.java) {
      copyVerifiedApk(ByteArrayInputStream(bytes), output, 3, digest, { throw InterruptedIOException() }) {}
    }
    assertEquals(0, output.size())
  }
}
