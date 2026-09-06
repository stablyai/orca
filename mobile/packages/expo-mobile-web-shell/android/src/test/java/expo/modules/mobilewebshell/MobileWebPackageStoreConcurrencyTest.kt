package expo.modules.mobilewebshell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MobileWebPackageStoreConcurrencyTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun serializesConcurrentHostsAndDuplicateGenerationCommits() {
    val root = temporary.newFolder()
    val store = concurrencyStore(root)
    val failures = ConcurrentLinkedQueue<Throwable>()

    runConcurrent(24, failures) { index ->
      val host = "concurrent-host-$index"
      val fixture = concurrencyFixture("<title>$index</title>")
      concurrencyStagePackage(store, host, fixture)
      val session = store.openSession(host, fixture.buildId, 1)
      val sessionId = session.getValue("sessionId")
      assertArrayEquals(fixture.bytes, store.readAsset(sessionId, "index.html").bytes)
      assertEquals(fixture.buildId, store.markSessionHealthy(sessionId))
      store.closeSession(sessionId)
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())

    val duplicate = concurrencyFixture("<title>same generation</title>")
    runConcurrent(24, failures) {
      concurrencyStagePackage(store, "same-host", duplicate)
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())
    runConcurrent(24, failures) {
      val session = store.openSession("same-host", duplicate.buildId, 1)
      val sessionId = session.getValue("sessionId")
      assertArrayEquals(duplicate.bytes, store.readAsset(sessionId, "index.html").bytes)
      assertEquals(duplicate.buildId, store.markSessionHealthy(sessionId))
      store.closeSession(sessionId)
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())
    val session = store.openSession("same-host", null, 1)
    assertArrayEquals(
      duplicate.bytes,
      store.readAsset(session.getValue("sessionId"), "index.html").bytes
    )
    val staging = File(root, "${concurrencySha256("same-host".toByteArray())}/staging")
    assertFalse(staging.listFiles()?.isNotEmpty() == true)
  }

  @Test
  fun preservesCompetingLiveGenerationsDuringConcurrentActivation() {
    val root = temporary.newFolder()
    val store = concurrencyStore(root)
    val failures = ConcurrentLinkedQueue<Throwable>()
    val fixtures = (0 until 16).map {
      concurrencyFixture("<title>generation-$it</title>")
    }

    runConcurrent(fixtures.size, failures) { index ->
      concurrencyStagePackage(store, "generation-host", fixtures[index])
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())

    val sessions = fixtures.map { store.openSession("generation-host", it.buildId, 1) }
    runConcurrent(sessions.size, failures) { index ->
      val sessionId = sessions[index].getValue("sessionId")
      assertArrayEquals(fixtures[index].bytes, store.readAsset(sessionId, "index.html").bytes)
      assertEquals(fixtures[index].buildId, store.markSessionHealthy(sessionId))
      assertArrayEquals(fixtures[index].bytes, store.readAsset(sessionId, "index.html").bytes)
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())

    val active = store.openSession("generation-host", null, 1)
    val activeBuildId = active.getValue("buildId")
    val activeFixture = fixtures.first { it.buildId == activeBuildId }
    assertArrayEquals(
      activeFixture.bytes,
      store.readAsset(active.getValue("sessionId"), "index.html").bytes
    )
    sessions.forEach { store.closeSession(it.getValue("sessionId")) }
    assertEquals(activeBuildId, store.markSessionHealthy(active.getValue("sessionId")))
    val generations = File(
      root,
      "${concurrencySha256("generation-host".toByteArray())}/generations"
    )
    assertTrue(generations.listFiles().orEmpty().size <= 2)
    store.closeSession(active.getValue("sessionId"))
  }

  @Test
  fun serializesConcurrentCommitAndAbortMutations() {
    val root = temporary.newFolder()
    val store = concurrencyStore(root)
    val failures = ConcurrentLinkedQueue<Throwable>()
    val fixtures = (0 until 16).map { concurrencyFixture("<title>stage-$it</title>") }
    val stages = fixtures.map { store.beginStage("stage-host", it.manifest, it.canonical) }

    runConcurrent(stages.size, failures) { index ->
      if (index % 2 == 0) {
        concurrencyFinishStage(store, stages[index], fixtures[index])
      } else {
        store.abortStage(stages[index])
      }
    }
    assertTrue(failures.joinToString("\n") { it.stackTraceToString() }, failures.isEmpty())

    fixtures.forEachIndexed { index, fixture ->
      if (index % 2 == 0) {
        val session = store.openSession("stage-host", fixture.buildId, 1)
        assertArrayEquals(
          fixture.bytes,
          store.readAsset(session.getValue("sessionId"), "index.html").bytes
        )
        store.closeSession(session.getValue("sessionId"))
      } else {
        assertTrue(runCatching { store.openSession("stage-host", fixture.buildId, 1) }.isFailure)
      }
    }
    store.removeHost("stage-host")
    val hostRoot = File(root, concurrencySha256("stage-host".toByteArray()))
    assertFalse(hostRoot.exists())
  }

  private fun runConcurrent(
    count: Int,
    failures: ConcurrentLinkedQueue<Throwable>,
    operation: (Int) -> Unit
  ) {
    val executor = Executors.newFixedThreadPool(count)
    val ready = CountDownLatch(count)
    val start = CountDownLatch(1)
    val complete = CountDownLatch(count)
    repeat(count) { index ->
      executor.execute {
        ready.countDown()
        try {
          start.await()
          operation(index)
        } catch (error: Throwable) {
          failures += error
        } finally {
          complete.countDown()
        }
      }
    }
    assertTrue(ready.await(10, TimeUnit.SECONDS))
    start.countDown()
    assertTrue(complete.await(30, TimeUnit.SECONDS))
    executor.shutdownNow()
  }

  private fun concurrencyStagePackage(
    store: MobileWebPackageStore,
    host: String,
    fixture: ConcurrencyFixture
  ) {
    val stageId = store.beginStage(host, fixture.manifest, fixture.canonical)
    concurrencyFinishStage(store, stageId, fixture)
  }

  private fun concurrencyFinishStage(
    store: MobileWebPackageStore,
    stageId: String,
    fixture: ConcurrencyFixture
  ) {
    store.writeAssetChunk(
      stageId,
      "index.html",
      0,
      Base64.getEncoder().encodeToString(fixture.bytes),
      concurrencySha256(fixture.bytes)
    )
    store.finishAsset(stageId, "index.html")
    assertEquals(fixture.buildId, store.commitStage(stageId))
  }

  private fun concurrencyFixture(content: String): ConcurrencyFixture {
    val bytes = content.toByteArray()
    val asset = JSONObject()
      .put("path", "index.html")
      .put("sha256", concurrencySha256(bytes))
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
    val buildId = concurrencySha256(canonical.toByteArray())
    val manifest = JSONObject(canonical).put("buildId", buildId).toString()
    return ConcurrencyFixture(bytes, canonical, manifest, buildId)
  }

  private fun concurrencyStore(root: File): MobileWebPackageStore =
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

  private fun concurrencySha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private data class ConcurrencyFixture(
    val bytes: ByteArray,
    val canonical: String,
    val manifest: String,
    val buildId: String
  )
}
