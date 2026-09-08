package expo.modules.mobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

class MobileWebCacheCleanupBoundaryTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun cleanupAndHostRemovalDoNotFollowSymbolicLinks() {
    val cacheRoot = temporary.newFolder("cache")
    val externalRoot = temporary.newFolder("external")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val hostRoot = mobileWebStoreHostRoot(cacheRoot, "paired-host")
    val stagingRoot = File(hostRoot, "tmp")
    require(stagingRoot.mkdirs())
    val orphanLink = File(stagingRoot, "orphan")
    Files.createSymbolicLink(orphanLink.toPath(), externalRoot.toPath())

    val store = jvmMobileWebPackageStore(cacheRoot)
    assertTrue(sentinel.exists())
    assertFalse(stagingRoot.exists())

    Files.createSymbolicLink(File(hostRoot, "linked-external").toPath(), externalRoot.toPath())
    store.removeHost("paired-host")
    assertTrue(sentinel.exists())
    assertFalse(hostRoot.exists())
  }

  @Test
  fun orphanTreeCleanupDoesNotFollowNestedSymbolicLinks() {
    val cacheRoot = temporary.newFolder("cache-nested")
    val externalRoot = temporary.newFolder("external-nested")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val orphanRoot = File(mobileWebStoreHostRoot(cacheRoot, "nested-host"), "tmp/orphan")
    require(orphanRoot.mkdirs())
    File(orphanRoot, "local").writeText("remove")
    Files.createSymbolicLink(File(orphanRoot, "external").toPath(), externalRoot.toPath())

    jvmMobileWebPackageStore(cacheRoot)

    assertTrue(sentinel.exists())
    assertFalse(orphanRoot.exists())
  }

  @Test
  fun stagingRejectsAStageRootReplacedBySymbolicLink() {
    val cacheRoot = temporary.newFolder("cache-live")
    val externalRoot = temporary.newFolder("external-live")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val fixture = mobileWebStoreFixture()
    val store = jvmMobileWebPackageStore(cacheRoot)
    store.stageAsset("live-host", fixture)
    val stageRoot = mobileWebStoreStagingRoot(cacheRoot, "live-host", fixture.buildId)
    assertTrue(stageRoot.deleteRecursively())
    Files.createSymbolicLink(stageRoot.toPath(), externalRoot.toPath())

    assertEquals(
      "mobile_web_staged_write_failed",
      assertThrows(IllegalArgumentException::class.java) {
        store.stageAsset("live-host", fixture)
      }.message
    )

    assertTrue(sentinel.exists())
    assertEquals(listOf("sentinel"), externalRoot.listFiles()?.map { it.name })
  }

  @Test
  fun hostRemovalDeletesDanglingSymbolicLink() {
    val cacheRoot = temporary.newFolder("cache-dangling")
    val hostRoot = mobileWebStoreHostRoot(cacheRoot, "dangling-host")
    Files.createSymbolicLink(hostRoot.toPath(), File(temporary.root, "missing-target").toPath())
    val store = jvmMobileWebPackageStore(cacheRoot)

    store.removeHost("dangling-host")

    assertFalse(Files.exists(hostRoot.toPath(), LinkOption.NOFOLLOW_LINKS))
  }
}
