package expo.modules.mobilewebshell

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileWebCacheCleanupBoundaryTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun cleanupAndHostRemovalDoNotFollowSymbolicLinks() {
    val cacheRoot = temporary.newFolder("cache")
    val externalRoot = temporary.newFolder("external")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val hostRoot = File(cacheRoot, sha256Hex("paired-host".toByteArray()))
    val stagingRoot = File(hostRoot, "staging")
    require(stagingRoot.mkdirs())
    val orphanLink = File(stagingRoot, "orphan")
    Files.createSymbolicLink(orphanLink.toPath(), externalRoot.toPath())

    val store = jvmMobileWebPackageStore(cacheRoot)
    assertTrue(sentinel.exists())
    assertFalse(Files.exists(orphanLink.toPath(), LinkOption.NOFOLLOW_LINKS))

    val hostLink = File(hostRoot, "linked-external")
    Files.createSymbolicLink(hostLink.toPath(), externalRoot.toPath())
    store.removeHost("paired-host")
    assertTrue(sentinel.exists())
    assertFalse(hostRoot.exists())
  }

  @Test
  fun orphanTreeCleanupDoesNotFollowNestedSymbolicLinks() {
    val cacheRoot = temporary.newFolder("cache-nested")
    val externalRoot = temporary.newFolder("external-nested")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val hostRoot = File(cacheRoot, sha256Hex("nested-host".toByteArray()))
    val orphanRoot = File(hostRoot, "staging/orphan")
    require(orphanRoot.mkdirs())
    File(orphanRoot, "local").writeText("remove")
    Files.createSymbolicLink(File(orphanRoot, "external").toPath(), externalRoot.toPath())

    jvmMobileWebPackageStore(cacheRoot)

    assertTrue(sentinel.exists())
    assertFalse(orphanRoot.exists())
  }

  @Test
  fun cleanupRejectsLiveStageReplacedBySymbolicLink() {
    val cacheRoot = temporary.newFolder("cache-live")
    val externalRoot = temporary.newFolder("external-live")
    val sentinel = File(externalRoot, "sentinel").apply { writeText("keep") }
    val fixture = packageFixture()
    val store = jvmMobileWebPackageStore(cacheRoot)
    val firstStage = store.beginStage("live-host", fixture.first, fixture.second)
    val hostRoot = File(cacheRoot, sha256Hex("live-host".toByteArray()))
    val stageRoot = requireNotNull(File(hostRoot, "staging").listFiles()?.single())
    assertTrue(stageRoot.deleteRecursively())
    Files.createSymbolicLink(stageRoot.toPath(), externalRoot.toPath())

    val secondStage = store.beginStage("live-host", fixture.first, fixture.second)

    assertTrue(sentinel.exists())
    assertFalse(Files.exists(stageRoot.toPath(), LinkOption.NOFOLLOW_LINKS))
    store.abortStage(firstStage)
    store.abortStage(secondStage)
  }

  @Test
  fun quotaAccountingIgnoresLinkedExternalGenerationBytes() {
    val cacheRoot = temporary.newFolder("cache-quota")
    val externalRoot = temporary.newFolder("external-quota")
    val sentinel = File(externalRoot, "sentinel")
    RandomAccessFile(sentinel, "rw").use {
      it.setLength(MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT + 1)
    }
    val hostRoot = File(cacheRoot, sha256Hex("quota-host".toByteArray()))
    val generationsRoot = File(hostRoot, "generations")
    require(generationsRoot.mkdirs())
    val linkedGeneration = File(generationsRoot, "a".repeat(64))
    Files.createSymbolicLink(linkedGeneration.toPath(), externalRoot.toPath())

    assertTrue(sentinel.exists())
    assertTrue(mobileWebCacheLogicalByteLength(hostRoot, cacheRoot) == 0L)
  }

  @Test
  fun hostRemovalDeletesDanglingSymbolicLink() {
    val cacheRoot = temporary.newFolder("cache-dangling")
    val hostRoot = File(cacheRoot, sha256Hex("dangling-host".toByteArray()))
    Files.createSymbolicLink(
      hostRoot.toPath(),
      File(temporary.root, "missing-target").toPath()
    )
    val store = jvmMobileWebPackageStore(cacheRoot)

    store.removeHost("dangling-host")

    assertFalse(Files.exists(hostRoot.toPath(), LinkOption.NOFOLLOW_LINKS))
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun packageFixture(): Pair<String, String> {
    val bytes = "<!doctype html><title>Orca</title>".toByteArray()
    val asset = JSONObject()
      .put("path", "index.html")
      .put("sha256", sha256Hex(bytes))
      .put("byteLength", bytes.size)
      .put("contentType", "text/html; charset=utf-8")
      .put("role", "document")
    val canonical = JSONObject()
      .put("schemaVersion", 1)
      .put("bridge", JSONObject().put("minimum", 1).put("testedThrough", 1))
      .put("entrypoint", "index.html")
      .put("totalBytes", bytes.size)
      .put("assets", JSONArray().put(asset))
      .toString()
    val manifest = JSONObject(canonical)
      .put("buildId", sha256Hex(canonical.toByteArray()))
      .toString()
    return manifest to canonical
  }
}
