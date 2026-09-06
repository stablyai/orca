package expo.modules.mobilewebshell

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MobileWebCacheWriteBoundaryTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun stageWriteRejectsLinkedAsset() {
    val root = temporary.newFolder("cache-stage")
    val outside = temporary.newFile("outside-stage").apply { writeText("keep") }
    val fixture = packageFixture()
    val store = testStore(root)
    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)
    val stageRoot = requireNotNull(
      File(root, "${sha256Hex("paired-host".toByteArray())}/staging").listFiles()?.single()
    )
    val asset = File(stageRoot, "index.html")
    require(asset.delete())
    Files.createSymbolicLink(asset.toPath(), outside.toPath())

    val error = assertThrows(IllegalArgumentException::class.java) {
      store.writeAssetChunk(
        stageId,
        "index.html",
        0,
        Base64.getEncoder().encodeToString(fixture.bytes),
        sha256Hex(fixture.bytes)
      )
    }

    assertEquals("mobile_web_stage_write_failed", error.message)
    assertEquals("keep", outside.readText())
    store.abortStage(stageId)
  }

  @Test
  fun stageCreationRejectsLinkedStagingDirectory() {
    val root = temporary.newFolder("cache-stage-link")
    val outside = temporary.newFolder("outside-stage-link")
    val hostRoot = File(root, sha256Hex("paired-host".toByteArray())).apply { mkdirs() }
    Files.createSymbolicLink(File(hostRoot, "staging").toPath(), outside.toPath())

    val error = assertThrows(IllegalArgumentException::class.java) {
      testStore(root).beginStage("paired-host", packageFixture().manifest, packageFixture().canonical)
    }

    assertEquals("mobile_web_stage_create_failed", error.message)
    assertTrue(outside.listFiles().isNullOrEmpty())
  }

  @Test
  fun stageCommitRejectsLinkedGenerationsDirectory() {
    val root = temporary.newFolder("cache-generation-link")
    val outside = temporary.newFolder("outside-generation-link")
    val fixture = packageFixture()
    val store = testStore(root)
    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)
    store.writeAssetChunk(
      stageId,
      "index.html",
      0,
      Base64.getEncoder().encodeToString(fixture.bytes),
      sha256Hex(fixture.bytes)
    )
    store.finishAsset(stageId, "index.html")
    val hostRoot = File(root, sha256Hex("paired-host".toByteArray()))
    val generations = File(hostRoot, "generations")
    Files.createSymbolicLink(generations.toPath(), outside.toPath())

    val error = assertThrows(IllegalArgumentException::class.java) {
      store.commitStage(stageId)
    }

    assertEquals("mobile_web_generation_create_failed", error.message)
    assertTrue(outside.listFiles().isNullOrEmpty())
    store.abortStage(stageId)
  }

  @Test
  fun activationWriteRejectsLinkedHostTree() {
    val root = temporary.newFolder("cache-activation")
    val externalRoot = temporary.newFolder("outside-activation")
    val activation = File(externalRoot, "activation.json").apply { writeText("keep") }
    val externalFile = temporary.newFile("outside-activation-file").apply { writeText("keep-file") }
    val fixture = packageFixture()
    val store = testStore(root)
    stagePackage(store, fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    val hostRoot = File(root, sha256Hex("paired-host".toByteArray()))
    val activationLink = File(hostRoot, "activation.json")
    Files.createSymbolicLink(activationLink.toPath(), externalFile.toPath())

    assertEquals(fixture.buildId, store.markSessionHealthy(session.getValue("sessionId")))
    assertEquals("keep-file", externalFile.readText())

    assertTrue(hostRoot.deleteRecursively())
    Files.createSymbolicLink(hostRoot.toPath(), externalRoot.toPath())

    val error = assertThrows(IllegalArgumentException::class.java) {
      store.markSessionHealthy(session.getValue("sessionId"))
    }

    assertEquals("mobile_web_activation_write_failed", error.message)
    assertEquals("keep", activation.readText())
  }

  private fun stagePackage(store: MobileWebPackageStore, fixture: PackageFixture) {
    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)
    store.writeAssetChunk(
      stageId,
      "index.html",
      0,
      Base64.getEncoder().encodeToString(fixture.bytes),
      sha256Hex(fixture.bytes)
    )
    store.finishAsset(stageId, "index.html")
    assertEquals(fixture.buildId, store.commitStage(stageId))
  }

  private fun packageFixture(): PackageFixture {
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
    val buildId = sha256Hex(canonical.toByteArray())
    val manifest = JSONObject(canonical).put("buildId", buildId).toString()
    return PackageFixture(bytes, canonical, manifest, buildId)
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun testStore(root: File): MobileWebPackageStore =
    jvmMobileWebPackageStore(
      root,
      replaceActivation = { source, destination ->
        Files.move(
          source.toPath(),
          destination.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING
        )
      }
    )

  private data class PackageFixture(
    val bytes: ByteArray,
    val canonical: String,
    val manifest: String,
    val buildId: String
  )
}
