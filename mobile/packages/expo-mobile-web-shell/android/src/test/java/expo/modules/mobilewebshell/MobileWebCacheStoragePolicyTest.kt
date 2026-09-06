package expo.modules.mobilewebshell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class MobileWebCacheStoragePolicyTest {
  @Test
  fun `keeps all generations when projected usage fits`() {
    val plan = mobileWebCacheEvictionPlan(
      candidates = listOf(candidate("host-a", "1", 10, 1)),
      targetHostKey = "host-a",
      projectedHostBytes = MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT,
      projectedGlobalBytes = MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT
    )

    assertEquals(emptyList<MobileWebCacheGenerationCandidate>(), plan)
  }

  @Test
  fun `evicts the oldest target-host generation for its quota`() {
    val oldest = candidate("host-a", "1", 10, 1)
    val newer = candidate("host-a", "2", 10, 2)
    val plan = mobileWebCacheEvictionPlan(
      candidates = listOf(newer, oldest),
      targetHostKey = "host-a",
      projectedHostBytes = MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT + 10,
      projectedGlobalBytes = MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT
    )

    assertEquals(listOf(oldest), plan)
  }

  @Test
  fun `global eviction prefers another host before the target host`() {
    val target = candidate("host-a", "1", 10, 1)
    val other = candidate("host-b", "2", 10, 2)
    val plan = mobileWebCacheEvictionPlan(
      candidates = listOf(target, other),
      targetHostKey = "host-a",
      projectedHostBytes = MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT,
      projectedGlobalBytes = MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT + 10
    )

    assertEquals(listOf(other), plan)
  }

  @Test
  fun `fails closed when protected usage alone exceeds the quota`() {
    val plan = mobileWebCacheEvictionPlan(
      candidates = emptyList(),
      targetHostKey = "host-a",
      projectedHostBytes = MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT + 1,
      projectedGlobalBytes = MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT
    )

    assertNull(plan)
  }

  @Test
  fun `accepts an existing asset parent directory`() {
    val root = Files.createTempDirectory("orca-mobile-web").toFile()
    val asset = File(root, "assets/index.js")

    try {
      requireMobileWebAssetParent(asset)
      requireMobileWebAssetParent(asset)

      assertTrue(requireNotNull(asset.parentFile).isDirectory)
    } finally {
      root.deleteRecursively()
    }
  }

  private fun candidate(
    hostKey: String,
    buildId: String,
    byteLength: Long,
    modifiedAtMillis: Long
  ) = MobileWebCacheGenerationCandidate(
    hostKey = hostKey,
    buildId = buildId,
    byteLength = byteLength,
    modifiedAtMillis = modifiedAtMillis,
    root = File("/$hostKey/$buildId")
  )
}
