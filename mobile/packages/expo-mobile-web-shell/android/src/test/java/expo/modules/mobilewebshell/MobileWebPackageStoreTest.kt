package expo.modules.mobilewebshell

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64

class MobileWebPackageStoreTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun commitsAndReadsOnlyTheExactVerifiedGeneration() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()

    store.commitFixture("paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    val sessionId = session.getValue("sessionId")
    val asset = store.readAsset(sessionId, "index.html")

    assertEquals(fixture.buildId, session["buildId"])
    assertEquals(43, sessionId.length)
    assertTrue(Regex("[A-Za-z0-9_-]{43}").matches(sessionId))
    assertEquals("${mobileWebOriginForSession(sessionId)}/#$sessionId", session["url"])
    assertEquals("text/html; charset=utf-8", asset.contentType)
    assertArrayEquals(fixture.bytes, asset.bytes)
    assertEquals(fixture.buildId, store.openSession("paired-host", null, 1)["buildId"])
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("different-host", fixture.buildId, 1)
      }.message
    )
    assertEquals(
      "mobile_web_bridge_incompatible",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", fixture.buildId, 2)
      }.message
    )
    assertFalse(
      mobileWebStoreStagingRoot(root, "paired-host", fixture.buildId).exists()
    )
  }

  @Test
  fun commitsAllPackagedDocuments() {
    val store = jvmMobileWebPackageStore(temporary.newFolder())
    val paths = listOf("index.html", "markdown-editor.html", "mermaid-frame.html")
    val fixture = mobileWebStoreFixture { manifest ->
      val asset = manifest.getJSONArray("assets").getJSONObject(0)
      manifest.put("assets", org.json.JSONArray(paths.map { path ->
        JSONObject(asset.toString()).put("path", path)
      }))
      manifest.put("totalBytes", manifest.getInt("totalBytes") * paths.size)
    }
    paths.forEach { path ->
      store.writeStagedAsset(
        "paired-host", fixture.buildId, path, Base64.getEncoder().encodeToString(fixture.bytes)
      )
    }
    store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    paths.forEach { path ->
      val asset = store.readAsset(session.getValue("sessionId"), path)
      assertArrayEquals(fixture.bytes, asset.bytes)
      assertTrue(asset.isDocument)
    }
  }

  @Test
  fun rejectsManifestsThatDoNotHashToTheBuildId() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val valid = mobileWebStoreFixture()
    val invalid = listOf(
      valid.copy(manifestJson = "${valid.manifestJson} "),
      valid.copy(buildId = "a".repeat(64)),
      valid.copy(buildId = "not-a-hash"),
      mobileWebStoreFixtureOf(
        valid.bytes,
        valid.manifestJson.dropLast(1) + ""","buildId":"${valid.buildId}"}"""
      ),
      mobileWebStoreFixture { it.getJSONArray("assets").getJSONObject(0).put("path", "../x.html") },
      mobileWebStoreFixture {
        it.getJSONArray("assets").getJSONObject(0).put("contentType", "application/octet-stream")
      },
      mobileWebStoreFixture { it.put("totalBytes", valid.bytes.size + 1) },
      mobileWebStoreFixture { it.put("entrypoint", "other.html") },
      mobileWebStoreFixture { it.getJSONObject("bridge").put("minimum", 2) }
    )

    invalid.forEach { fixture ->
      assertEquals(
        "mobile_web_manifest_invalid",
        assertThrows(IllegalArgumentException::class.java) {
          store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
        }.message
      )
    }
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
    val valid = listOf("index.html", "assets/${"a".repeat(64)}.js", "assets/a_b-c.d.js")

    invalid.forEach { assertFalse(it, isSafeMobileWebAssetPath(it)) }
    valid.forEach { assertTrue(it, isSafeMobileWebAssetPath(it)) }
  }

  @Test
  fun acceptsOnlyExactSha256Tokens() {
    val invalid = listOf("", "a".repeat(63), "a".repeat(65), "${"a".repeat(64)}\n", "A".repeat(64))

    invalid.forEach { assertFalse(it, isMobileWebSha256(it)) }
    assertTrue(isMobileWebSha256("a".repeat(64)))
  }

  @Test
  fun acceptsOnlyExactAssetMetadata() {
    val hash = "a".repeat(64)
    val valid = listOf(
      arrayOf("index.html", hash, "text/html; charset=utf-8", "document"),
      arrayOf("mermaid-frame.html", hash, "text/html; charset=utf-8", "document"),
      arrayOf("markdown-editor.html", hash, "text/html; charset=utf-8", "document"),
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
      assertTrue(path, isValidMobileWebAssetMetadata(path, assetHash, contentType, role))
    }
    invalid.forEach { (path, assetHash, contentType, role) ->
      assertFalse(path, isValidMobileWebAssetMetadata(path, assetHash, contentType, role))
    }
  }

  @Test
  fun rejectsQuotedAndBooleanNumericManifestFields() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val size = mobileWebStoreFixture().bytes.size
    val invalid = listOf<(JSONObject) -> Unit>(
      { it.put("schemaVersion", "1") },
      { it.getJSONObject("bridge").put("minimum", "1") },
      { it.getJSONObject("bridge").put("testedThrough", "1") },
      { it.put("totalBytes", size.toString()) },
      { it.getJSONArray("assets").getJSONObject(0).put("byteLength", size.toString()) },
      { it.put("schemaVersion", true) },
      { it.getJSONObject("bridge").put("minimum", true) },
      { it.getJSONObject("bridge").put("testedThrough", true) },
      { it.put("totalBytes", true) },
      { it.getJSONArray("assets").getJSONObject(0).put("byteLength", true) }
    )

    invalid.forEach { mutate ->
      val fixture = mobileWebStoreFixture(mutate = mutate)
      assertEquals(
        "mobile_web_manifest_invalid",
        assertThrows(IllegalArgumentException::class.java) {
          store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
        }.message
      )
    }
  }

  @Test
  fun rejectsOversizedManifestInputBeforeParsing() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val oversized = " ".repeat(256 * 1024 + 1)

    assertEquals(
      "mobile_web_manifest_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration(
          "paired-host",
          mobileWebStoreSha256Hex(oversized.toByteArray(Charsets.UTF_8)),
          oversized
        )
      }.message
    )
  }

  @Test
  fun dropsStagedTreesWhenTheStoreRestarts() {
    val root = temporary.newFolder()
    val first = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()
    first.stageAsset("paired-host", fixture)
    val staging = File(mobileWebStoreHostRoot(root, "paired-host"), "tmp")
    assertEquals(1, staging.listFiles()?.size)

    jvmMobileWebPackageStore(root)

    assertFalse(staging.exists())
    assertEquals(
      "mobile_web_staged_generation_incomplete",
      assertThrows(IllegalArgumentException::class.java) {
        first.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
  }

  @Test
  fun rejectsUnusableStagedAssetInput() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()
    val encoded = Base64.getEncoder().encodeToString(fixture.bytes)
    val invalid = listOf(
      Triple(fixture.buildId, "index.html", "A".repeat(14 * 1024 * 1024)),
      Triple(fixture.buildId, "index.html", "not base64!"),
      Triple(fixture.buildId, "index.html", ""),
      Triple(fixture.buildId, "../escape.html", encoded),
      Triple(fixture.buildId, "manifest.json", encoded),
      Triple("not-a-build-id", "index.html", encoded)
    )

    invalid.forEach { (buildId, path, data) ->
      assertEquals(
        "mobile_web_staged_asset_invalid",
        assertThrows(IllegalArgumentException::class.java) {
          store.writeStagedAsset("paired-host", buildId, path, data)
        }.message
      )
    }
  }

  @Test
  fun rejectsIncompleteStagedTreesAndCorruptionOnOpenAndRead() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()

    assertEquals(
      "mobile_web_staged_generation_incomplete",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
    store.stageAsset("paired-host", fixture)
    store.writeStagedAsset(
      "paired-host",
      fixture.buildId,
      "assets/extra.js",
      Base64.getEncoder().encodeToString(fixture.bytes)
    )
    assertEquals(
      "mobile_web_staged_generation_incomplete",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
    store.abortGeneration("paired-host", fixture.buildId)

    store.commitFixture("paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    File(mobileWebStoreGenerations(root, "paired-host"), "${fixture.buildId}/index.html")
      .writeText("corrupt")

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
  }

  @Test
  fun repairsRedownloadedGeneration() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()
    store.commitFixture("paired-host", fixture)
    val generation = File(mobileWebStoreGenerations(root, "paired-host"), fixture.buildId)

    for (path in listOf("index.html", "manifest.json")) {
      File(generation, path).writeText("corrupt")
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", null, 1)
      }
      store.commitFixture("paired-host", fixture)
      val restored = store.openSession("paired-host", null, 1).getValue("sessionId")
      assertArrayEquals(fixture.bytes, store.readAsset(restored, "index.html").bytes)
      store.closeSession(restored)
    }
  }

  @Test
  fun rejectsOversizedPersistedFiles() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()
    store.commitFixture("paired-host", fixture)
    val session = store.openSession("paired-host", fixture.buildId, 1)
    val generation = File(mobileWebStoreGenerations(root, "paired-host"), fixture.buildId)
    val manifest = File(generation, "manifest.json")

    manifest.writeBytes(ByteArray(256 * 1024 + 1) { 0x20 })
    assertEquals(
      "mobile_web_generation_invalid",
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("paired-host", fixture.buildId, 1)
      }.message
    )
    manifest.writeText(fixture.manifestJson, Charsets.UTF_8)

    File(generation, "index.html").writeBytes(ByteArray(fixture.bytes.size + 1))
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
  }

  @Test
  fun keepsOnlyTheCommittedGenerationOnceNoSessionHoldsTheOldOne() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val previous = mobileWebStoreFixture(content = "<!doctype html><title>Previous</title>")
    val current = mobileWebStoreFixture(content = "<!doctype html><title>Current</title>")
    store.commitFixture("paired-host", previous)
    val previousSession = store.openSession("paired-host", previous.buildId, 1)

    store.commitFixture("paired-host", current)

    assertArrayEquals(
      previous.bytes,
      store.readAsset(previousSession.getValue("sessionId"), "index.html").bytes
    )
    val active = store.openSession("paired-host", null, 1)
    assertEquals(current.buildId, active["buildId"])

    store.closeSession(previousSession.getValue("sessionId"))
    store.closeSession(active.getValue("sessionId"))

    assertEquals(
      listOf(current.buildId),
      mobileWebStoreGenerations(root, "paired-host").listFiles()?.map { it.name }
    )
  }

  @Test
  fun abortsAStagedGeneration() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture()
    store.stageAsset("paired-host", fixture)
    val staged = mobileWebStoreStagingRoot(root, "paired-host", fixture.buildId)
    assertTrue(staged.exists())

    store.abortGeneration("paired-host", fixture.buildId)

    assertFalse(staged.exists())
    assertEquals(
      "mobile_web_staged_generation_incomplete",
      assertThrows(IllegalArgumentException::class.java) {
        store.commitGeneration("paired-host", fixture.buildId, fixture.manifestJson)
      }.message
    )
  }

  @Test
  fun evictsTheLeastRecentlyActivatedHostOverTheCap() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val hosts = (0..4).map { "cap-host-$it" }
    val fixtures = hosts.mapIndexed { index, host ->
      val fixture = mobileWebStoreFixture(content = "<!doctype html><title>$index</title>")
      store.commitFixture(host, fixture)
      store.closeSession(store.openSession(host, null, 1).getValue("sessionId"))
      // The eviction order is the activation order, which is the host root's modification time.
      mobileWebStoreHostRoot(root, host).setLastModified(1_000_000L + index * 1_000L)
      host to fixture
    }.toMap()

    store.commitFixture(hosts[4], fixtures.getValue(hosts[4]))

    assertFalse(mobileWebStoreHostRoot(root, hosts[0]).exists())
    hosts.drop(1).forEach { host ->
      val session = store.openSession(host, null, 1).getValue("sessionId")
      assertArrayEquals(fixtures.getValue(host).bytes, store.readAsset(session, "index.html").bytes)
      store.closeSession(session)
    }
  }

  @Test
  fun removesOnlyTheSelectedHostCacheAndSessions() {
    val root = temporary.newFolder()
    val store = jvmMobileWebPackageStore(root)
    val removed = mobileWebStoreFixture(content = "<!doctype html><title>Removed</title>")
    val retained = mobileWebStoreFixture(content = "<!doctype html><title>Retained</title>")
    store.commitFixture("removed-host", removed)
    store.commitFixture("retained-host", retained)
    val removedSession = store.openSession("removed-host", removed.buildId, 1)
    val retainedSession = store.openSession("retained-host", retained.buildId, 1)
    store.stageAsset("removed-host", removed)

    store.removeHost("removed-host")

    assertFalse(mobileWebStoreHostRoot(root, "removed-host").exists())
    assertEquals(
      "mobile_web_asset_unavailable",
      assertThrows(IllegalArgumentException::class.java) {
        store.readAsset(removedSession.getValue("sessionId"), "index.html")
      }.message
    )
    assertArrayEquals(
      retained.bytes,
      store.readAsset(retainedSession.getValue("sessionId"), "index.html").bytes
    )
  }
}
