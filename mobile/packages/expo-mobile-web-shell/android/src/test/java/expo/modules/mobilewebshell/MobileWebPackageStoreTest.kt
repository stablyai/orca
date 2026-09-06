package expo.modules.mobilewebshell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64

class MobileWebPackageStoreTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun repairsRedownloadedGeneration() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()
    stagePackage(store, "paired-host", fixture)
    val sessionId = store.openSession("paired-host", fixture.buildId, 1).getValue("sessionId")
    store.markSessionHealthy(sessionId)
    val generation = File(root, "${sha256Hex("paired-host".toByteArray())}/generations/${fixture.buildId}")
    for (path in listOf("index.html", "manifest.json", "canonical-manifest.json")) {
      File(generation, path).writeText("corrupt")
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", null, 1)
      }
      stagePackage(store, "paired-host", fixture)
      val restored = store.openSession("paired-host", null, 1).getValue("sessionId")
      assertArrayEquals(fixture.bytes, store.readAsset(restored, "index.html").bytes)
      assertArrayEquals(fixture.bytes, store.readAsset(sessionId, "index.html").bytes)
      store.closeSession(restored)
    }
  }

  @Test
  fun stagesAndReadsOnlyTheExactVerifiedGeneration() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()

    stagePackage(store, "paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    val sessionId = session.getValue("sessionId")
    val asset = store.readAsset(sessionId, "index.html")

    assertEquals(fixture.buildId, session["buildId"])
    assertEquals(43, sessionId.length)
    assertEquals(true, Regex("[A-Za-z0-9_-]{43}").matches(sessionId))
    assertEquals("${mobileWebOriginForSession(sessionId)}/#$sessionId", session["url"])
    assertEquals("text/html; charset=utf-8", asset.contentType)
    assertArrayEquals(fixture.bytes, asset.bytes)
    val error = assertThrows(IllegalArgumentException::class.java) {
      store.openSession("different-host", fixture.buildId, 1)
    }
    assertEquals("mobile_web_generation_invalid", error.message)
  }

  @Test
  fun rejectsMalformedManifestIdentityPathMimeAndTotalsBeforeCreatingAStage() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val valid = packageFixture()
    val duplicateCanonical = valid.canonical.dropLast(1) + ""","schemaVersion":1}"""
    val duplicateBuildId = sha256Hex(duplicateCanonical.toByteArray())
    val duplicateManifest = JSONObject(valid.manifest)
      .put("buildId", duplicateBuildId)
      .toString()
    val invalid = listOf(
      valid.copy(canonical = "${valid.canonical} "),
      valid.copy(manifest = "${valid.manifest} trailing"),
      valid.copy(manifest = valid.manifest.dropLast(1) + ""","schemaVersion":1}"""),
      valid.copy(
        canonical = duplicateCanonical,
        manifest = duplicateManifest,
        buildId = duplicateBuildId
      ),
      packageFixture(mutateAsset = { asset -> asset.put("path", "../index.html") }),
      packageFixture(mutateAsset = { asset -> asset.put("contentType", "application/octet-stream") }),
      packageFixture { _, manifest -> manifest.put("totalBytes", valid.bytes.size + 1) }
    )

    invalid.forEach { fixture ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.beginStage("paired-host", fixture.manifest, fixture.canonical)
      }
      assertEquals("mobile_web_stage_manifest_invalid", error.message)
    }
    assertFalse(root.walkTopDown().any { it.name == "staging" && it.listFiles()?.isNotEmpty() == true })
  }

  @Test
  fun acceptsOnlyExactCanonicalAssetPaths() {
    val invalid = listOf(
      "",
      "../index.html",
      "./index.html",
      "/index.html",
      "index.html/",
      "assets//app.js",
      "assets\\app.js",
      "assets/app.js?query",
      "assets/app.js#fragment",
      "assets/%2e%2e/app.js",
      "assets/./app.js",
      "assets/../app.js",
      "assets/app.js\n",
      "a".repeat(241),
      "assets/café.js"
    )
    val valid = listOf(
      "index.html",
      "assets/${"a".repeat(64)}.js",
      "assets/a_b-c.d.js"
    )

    invalid.forEach { assertFalse(it, isSafeMobileWebAssetPath(it)) }
    valid.forEach { assertEquals(it, true, isSafeMobileWebAssetPath(it)) }
  }

  @Test
  fun acceptsOnlyExactSha256Tokens() {
    val invalid = listOf(
      "",
      "a".repeat(63),
      "a".repeat(65),
      "${"a".repeat(64)}\n",
      "A".repeat(64)
    )

    invalid.forEach { assertFalse(it, isMobileWebSha256(it)) }
    assertEquals(true, isMobileWebSha256("a".repeat(64)))
  }

  @Test
  fun acceptsOnlyExactAssetMetadata() {
    val hash = "a".repeat(64)
    val valid = listOf(
      arrayOf("index.html", hash, "text/html; charset=utf-8", "document"),
      arrayOf("mermaid-frame.html", hash, "text/html; charset=utf-8", "document"),
      arrayOf("assets/$hash.css", hash, "text/css; charset=utf-8", "style"),
      arrayOf("assets/$hash.js", hash, "text/javascript; charset=utf-8", "script"),
      arrayOf("assets/$hash.png", hash, "image/png", "image"),
      arrayOf("assets/$hash.svg", hash, "image/svg+xml; charset=utf-8", "image"),
      arrayOf("assets/$hash.wasm", hash, "application/wasm", "wasm"),
      arrayOf("assets/$hash.webp", hash, "image/webp", "image"),
      arrayOf("assets/$hash.woff2", hash, "font/woff2", "font")
    )
    val invalid = listOf(
      arrayOf("assets/$hash.js", hash, "text/css; charset=utf-8", "script"),
      arrayOf("assets/$hash.js", hash, "text/javascript; charset=utf-8", "style"),
      arrayOf("assets/$hash.png", hash, "image/png; charset=utf-8", "image"),
      arrayOf("assets/$hash.JS", hash, "text/javascript; charset=utf-8", "script"),
      arrayOf("assets/$hash.txt", hash, "text/plain; charset=utf-8", "document"),
      arrayOf("other-frame.html", hash, "text/html; charset=utf-8", "document"),
      arrayOf("assets/$hash.js", "b".repeat(64), "text/javascript; charset=utf-8", "script"),
      arrayOf("index.html", hash, "text/html; charset=UTF-8", "document"),
      arrayOf("index.html", hash, "text/html; charset=utf-8", "document ")
    )

    valid.forEach { (path, assetHash, contentType, role) ->
      assertEquals(path, true, isValidMobileWebAssetMetadata(path, assetHash, contentType, role))
    }
    invalid.forEach { (path, assetHash, contentType, role) ->
      assertFalse(path, isValidMobileWebAssetMetadata(path, assetHash, contentType, role))
    }
  }

  @Test
  fun rejectsQuotedNumericManifestFieldsBeforeCreatingAStage() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val valid = packageFixture()
    val invalid = listOf(
      packageFixture { _, manifest -> manifest.put("schemaVersion", "1") },
      packageFixture { _, manifest ->
        manifest.getJSONObject("bridge").put("minimum", "1")
      },
      packageFixture { _, manifest ->
        manifest.getJSONObject("bridge").put("testedThrough", "1")
      },
      packageFixture { _, manifest -> manifest.put("totalBytes", valid.bytes.size.toString()) },
      packageFixture(mutateAsset = { asset ->
        asset.put("byteLength", valid.bytes.size.toString())
      })
    )

    invalid.forEach { fixture ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.beginStage("paired-host", fixture.manifest, fixture.canonical)
      }
      assertEquals("mobile_web_stage_manifest_invalid", error.message)
    }
    assertFalse(
      root.walkTopDown().any { it.name == "staging" && it.listFiles()?.isNotEmpty() == true }
    )
  }

  @Test
  fun rejectsBooleanNumericManifestFieldsBeforeCreatingAStage() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val invalid = listOf(
      packageFixture { _, manifest -> manifest.put("schemaVersion", true) },
      packageFixture { _, manifest ->
        manifest.getJSONObject("bridge").put("minimum", true)
      },
      packageFixture { _, manifest ->
        manifest.getJSONObject("bridge").put("testedThrough", true)
      },
      packageFixture { _, manifest -> manifest.put("totalBytes", true) },
      packageFixture(mutateAsset = { asset -> asset.put("byteLength", true) })
    )

    invalid.forEach { fixture ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.beginStage("paired-host", fixture.manifest, fixture.canonical)
      }
      assertEquals("mobile_web_stage_manifest_invalid", error.message)
    }
    assertFalse(
      root.walkTopDown().any { it.name == "staging" && it.listFiles()?.isNotEmpty() == true }
    )
  }

  @Test
  fun rejectsOversizedManifestInputBeforeParsing() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()

    listOf(
      " ".repeat(256 * 1024 + 1) to fixture.canonical,
      fixture.manifest to " ".repeat(256 * 1024 + 1)
    ).forEach { (manifest, canonical) ->
      val error = assertThrows(IllegalArgumentException::class.java) {
        store.beginStage("paired-host", manifest, canonical)
      }
      assertEquals("mobile_web_stage_manifest_invalid", error.message)
    }
    assertFalse(root.walkTopDown().any { it.name == "staging" })
  }

  @Test
  fun deletesAnInterruptedStageWhenTheStoreRestarts() {
    val root = temporary.newFolder()
    val firstStore = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()
    val stageId = firstStore.beginStage("paired-host", fixture.manifest, fixture.canonical)
    val stagingRoot = File(root, "${sha256Hex("paired-host".toByteArray())}/staging")

    assertEquals(1, stagingRoot.listFiles()?.size)
    jvmMobileWebPackageStore(root)

    assertFalse(stagingRoot.listFiles()?.isNotEmpty() == true)
    assertThrows(IllegalArgumentException::class.java) {
      firstStore.writeAssetChunk(
        stageId,
        "index.html",
        0,
        Base64.getEncoder().encodeToString(fixture.bytes),
        sha256Hex(fixture.bytes)
      )
    }
  }

  @Test
  fun rejectsOversizedEncodedChunksBeforeDecoding() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()
    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)

    val error = assertThrows(IllegalArgumentException::class.java) {
      store.writeAssetChunk(
        stageId,
        "index.html",
        0,
        "A".repeat(65_537),
        sha256Hex(fixture.bytes)
      )
    }

    assertEquals("mobile_web_stage_chunk_invalid", error.message)
    store.abortStage(stageId)
  }

  @Test
  fun rejectsIncompleteStagesAndCorruptionOnOpenAndRead() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()
    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)

    assertThrows(IllegalArgumentException::class.java) { store.commitStage(stageId) }
    store.abortStage(stageId)
    stagePackage(store, "paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    val generation = File(
      root,
      "${sha256Hex("paired-host".toByteArray())}/generations/${fixture.buildId}/index.html"
    )
    generation.writeText("corrupt")

    val readError = assertThrows(IllegalArgumentException::class.java) {
      store.readAsset(session.getValue("sessionId"), "index.html")
    }
    assertEquals("mobile_web_generation_invalid", readError.message)
    val openError = assertThrows(IllegalArgumentException::class.java) {
      store.openSession("paired-host", fixture.buildId, 1)
    }
    assertEquals("mobile_web_generation_invalid", openError.message)
  }

  @Test
  fun rejectsOversizedPersistedFiles() {
    val root = temporary.newFolder()
    val store = testStore(root)
    val fixture = packageFixture()
    stagePackage(store, "paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    store.markSessionHealthy(session.getValue("sessionId"))
    val hostRoot = File(root, sha256Hex("paired-host".toByteArray()))
    val generationRoot = File(hostRoot, "generations/${fixture.buildId}")
    val manifest = File(generationRoot, "manifest.json")
    val canonicalManifest = File(generationRoot, "canonical-manifest.json")
    val document = File(generationRoot, "index.html")

    manifest.writeBytes(ByteArray(256 * 1024 + 1) { 0x20 })
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", fixture.buildId, 1)
      }.message
    )
    manifest.writeText(fixture.manifest, Charsets.UTF_8)

    canonicalManifest.writeBytes(ByteArray(256 * 1024 + 1) { 0x20 })
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", fixture.buildId, 1)
      }.message
    )
    canonicalManifest.writeText(fixture.canonical, Charsets.UTF_8)

    document.writeBytes(ByteArray(fixture.bytes.size + 1))
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.readAsset(session.getValue("sessionId"), "index.html")
      }.message
    )
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", fixture.buildId, 1)
      }.message
    )

    File(hostRoot, "activation.json").writeBytes(ByteArray(1025) { 0x20 })
    assertEquals(
      "mobile_web_activation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", null, 1)
      }.message
    )
  }

  @Test
  fun activatesAndRecoversThePreviousVerifiedGeneration() {
    val root = temporary.newFolder()
    val store = testStore(root)
    val previous = packageFixture(content = "<!doctype html><title>Previous</title>")
    val current = packageFixture(content = "<!doctype html><title>Current</title>")
    stagePackage(store, "paired-host", previous)
    val previousSession = store.openSession("paired-host", previous.buildId, 1)
    assertEquals(previous.buildId, store.markSessionHealthy(previousSession.getValue("sessionId")))
    stagePackage(store, "paired-host", current)
    val currentSession = store.openSession("paired-host", current.buildId, 1)
    assertEquals(current.buildId, store.markSessionHealthy(currentSession.getValue("sessionId")))

    val recovered = store.recoverSession(currentSession.getValue("sessionId"))

    assertEquals(previous.buildId, recovered["buildId"])
    val active = store.openSession("paired-host", null, 1)
    assertEquals(previous.buildId, active["buildId"])
  }

  @Test
  fun fallsBackFromACorruptActiveGenerationOnColdOpen() {
    val root = temporary.newFolder()
    val store = testStore(root)
    val previous = packageFixture(content = "<!doctype html><title>Previous</title>")
    val current = packageFixture(content = "<!doctype html><title>Current</title>")
    stagePackage(store, "paired-host", previous)
    val previousSession = store.openSession("paired-host", previous.buildId, 1)
    store.markSessionHealthy(previousSession.getValue("sessionId"))
    store.closeSession(previousSession.getValue("sessionId"))
    stagePackage(store, "paired-host", current)
    val currentSession = store.openSession("paired-host", current.buildId, 1)
    store.markSessionHealthy(currentSession.getValue("sessionId"))
    store.closeSession(currentSession.getValue("sessionId"))
    val currentDocument = File(
      root,
      "${sha256Hex("paired-host".toByteArray())}/generations/${current.buildId}/index.html"
    )
    currentDocument.writeText("corrupt")

    val recovered = store.openSession("paired-host", null, 1)

    assertEquals(previous.buildId, recovered["buildId"])
    assertFalse(currentDocument.exists())
  }

  @Test
  fun rejectsLowStorageBeforeCreatingAStage() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(
      root,
      availableStorageBytes = { MOBILE_WEB_MINIMUM_FREE_STORAGE_BYTES }
    )
    val fixture = packageFixture()

    val error = assertThrows(IllegalArgumentException::class.java) {
      store.beginStage("paired-host", fixture.manifest, fixture.canonical)
    }

    assertEquals("mobile_web_cache_storage_unavailable", error.message)
    assertFalse(root.walkTopDown().any { it.name == "staging" && it.listFiles()?.isNotEmpty() == true })
  }

  @Test
  fun evictsAnUnprotectedGenerationBeforeStaging() {
    val root = temporary.newFolder()
    val store = testStore(root)
    val active = packageFixture(content = "<!doctype html><title>Active</title>")
    stagePackage(store, "paired-host", active)
    val activeSession = store.openSession("paired-host", active.buildId, 1)
    store.markSessionHealthy(activeSession.getValue("sessionId"))
    val hostKey = sha256Hex("paired-host".toByteArray())
    val staleRoot = File(root, "$hostKey/generations/${"a".repeat(64)}")
    require(staleRoot.mkdirs())
    RandomAccessFile(File(staleRoot, "stale.bin"), "rw").use {
      it.setLength(MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT)
    }
    val fixture = packageFixture(content = "<!doctype html><title>Next</title>")

    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)

    assertFalse(staleRoot.exists())
    assertArrayEquals(
      active.bytes,
      store.readAsset(activeSession.getValue("sessionId"), "index.html").bytes
    )
    store.abortStage(stageId)
  }

  @Test
  fun evictsAnotherHostsUnprotectedGenerationForTheGlobalQuota() {
    val root = temporary.newFolder()
    val otherHostKey = sha256Hex("other-host".toByteArray())
    val staleRoot = File(root, "$otherHostKey/generations/${"b".repeat(64)}")
    require(staleRoot.mkdirs())
    RandomAccessFile(File(staleRoot, "stale.bin"), "rw").use {
      it.setLength(MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT)
    }
    val store = jvmMobileWebPackageStore(root)
    val fixture = packageFixture()

    val stageId = store.beginStage("paired-host", fixture.manifest, fixture.canonical)

    assertFalse(staleRoot.exists())
    store.abortStage(stageId)
  }

  @Test
  fun removesOnlyTheSelectedHostCacheSessionsAndStages() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val removed = packageFixture(content = "<!doctype html><title>Removed</title>")
    val retained = packageFixture(content = "<!doctype html><title>Retained</title>")
    stagePackage(store, "removed-host", removed)
    stagePackage(store, "retained-host", retained)
    val removedSession = store.openSession("removed-host", removed.buildId, 1)
    val retainedSession = store.openSession("retained-host", retained.buildId, 1)
    val interruptedStage = store.beginStage("removed-host", removed.manifest, removed.canonical)

    store.removeHost("removed-host")

    assertFalse(File(root, sha256Hex("removed-host".toByteArray())).exists())
    assertThrows(IllegalArgumentException::class.java) {
      store.readAsset(removedSession.getValue("sessionId"), "index.html")
    }
    assertThrows(IllegalArgumentException::class.java) {
      store.writeAssetChunk(interruptedStage, "index.html", 0, "YQ==", sha256Hex("a".toByteArray()))
    }
    assertArrayEquals(
      retained.bytes,
      store.readAsset(retainedSession.getValue("sessionId"), "index.html").bytes
    )
  }

  private fun stagePackage(
    store: MobileWebPackageStore,
    hostIdentity: String,
    fixture: PackageFixture
  ) {
    val stageId = store.beginStage(hostIdentity, fixture.manifest, fixture.canonical)
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

  private fun packageFixture(
    content: String = "<!doctype html><title>Orca</title>",
    mutateAsset: (JSONObject) -> Unit = {},
    mutateManifest: (JSONObject, JSONObject) -> Unit = { _, _ -> }
  ): PackageFixture {
    val bytes = content.toByteArray()
    val asset = JSONObject()
      .put("path", "index.html")
      .put("sha256", sha256Hex(bytes))
      .put("byteLength", bytes.size)
      .put("contentType", "text/html; charset=utf-8")
      .put("role", "document")
    mutateAsset(asset)
    val canonical = JSONObject()
      .put("schemaVersion", 1)
      .put("bridge", JSONObject().put("minimum", 1).put("testedThrough", 1))
      .put("entrypoint", "index.html")
      .put("totalBytes", bytes.size)
      .put("assets", JSONArray().put(asset))
    mutateManifest(asset, canonical)
    val canonicalJson = canonical.toString()
    val buildId = sha256Hex(canonicalJson.toByteArray())
    val manifest = JSONObject(canonicalJson).put("buildId", buildId).toString()
    return PackageFixture(bytes, canonicalJson, manifest, buildId)
  }

  private fun testStore(root: File): MobileWebPackageStore =
    jvmMobileWebPackageStore(
      root,
      replaceActivation = { source, destination ->
        java.nio.file.Files.move(
          source.toPath(),
          destination.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING
        )
      }
    )
}

private data class PackageFixture(
  val bytes: ByteArray,
  val canonical: String,
  val manifest: String,
  val buildId: String
)

private fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
