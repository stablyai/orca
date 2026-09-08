package expo.modules.mobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class MobileWebCacheWriteBoundaryTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun stagedAssetWriteReplacesALinkedSlotInsteadOfFollowingIt() {
    val cacheRoot = temporary.newFolder("cache-asset")
    val outside = temporary.newFile("outside-asset").apply { writeText("keep") }
    val fixture = mobileWebStoreFixture()
    val store = jvmMobileWebPackageStore(cacheRoot)
    store.stageAsset("paired-host", fixture)
    val asset = File(
      mobileWebStoreStagingRoot(cacheRoot, "paired-host", fixture.buildId),
      "index.html"
    )
    require(asset.delete())
    Files.createSymbolicLink(asset.toPath(), outside.toPath())

    store.stageAsset("paired-host", fixture)

    assertEquals("keep", outside.readText())
    assertEquals(
      fixture.buildId,
      store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
    )
  }

  @Test
  fun stagingRejectsALinkedStagingDirectory() {
    val cacheRoot = temporary.newFolder("cache-staging-link")
    val outside = temporary.newFolder("outside-staging-link")
    val hostRoot = mobileWebStoreHostRoot(cacheRoot, "paired-host").apply { mkdirs() }
    val store = jvmMobileWebPackageStore(cacheRoot)
    Files.createSymbolicLink(File(hostRoot, "tmp").toPath(), outside.toPath())

    assertEquals(
      "mobile_web_staged_write_failed",
      assertThrows(IllegalArgumentException::class.java) {
        store.stageAsset("paired-host", mobileWebStoreFixture())
      }.message
    )
    assertTrue(outside.listFiles().isNullOrEmpty())
  }

  @Test
  fun commitRejectsALinkedGenerationsDirectory() {
    val cacheRoot = temporary.newFolder("cache-generation-link")
    val outside = temporary.newFolder("outside-generation-link")
    val fixture = mobileWebStoreFixture()
    val store = jvmMobileWebPackageStore(cacheRoot)
    store.stageAsset("paired-host", fixture)
    Files.createSymbolicLink(
      File(mobileWebStoreHostRoot(cacheRoot, "paired-host"), "generations").toPath(),
      outside.toPath()
    )

    assertEquals(
      "mobile_web_generation_commit_failed",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
    assertTrue(outside.listFiles().isNullOrEmpty())
  }

  @Test
  fun commitRejectsAStagedTreeCarryingAnUnnamedEntry() {
    val cacheRoot = temporary.newFolder("cache-extra")
    val outside = temporary.newFile("outside-manifest").apply { writeText("keep") }
    val fixture = mobileWebStoreFixture()
    val store = jvmMobileWebPackageStore(cacheRoot)
    store.stageAsset("paired-host", fixture)
    val stageRoot = mobileWebStoreStagingRoot(cacheRoot, "paired-host", fixture.buildId)
    Files.createSymbolicLink(File(stageRoot, "manifest.json").toPath(), outside.toPath())

    assertEquals(
      "mobile_web_staged_generation_incomplete",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
    assertEquals("keep", outside.readText())
  }
}
