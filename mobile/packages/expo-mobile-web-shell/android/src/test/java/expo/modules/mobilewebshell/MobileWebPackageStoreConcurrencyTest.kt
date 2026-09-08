package expo.modules.mobilewebshell

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MobileWebPackageStoreConcurrencyTest {
  @get:Rule
  val temporary = TemporaryFolder()

  @Test
  fun independentHostsCommitAndServeConcurrently() {
    val root = temporary.newFolder("hosts")
    val store = jvmMobileWebPackageStore(root)

    val failures = runConcurrently(24) { iteration ->
      val index = iteration % 4
      val host = "concurrent-host-$index"
      val fixture = mobileWebStoreFixture(content = "<title>$index</title>")
      store.commitFixture(host, fixture)
      val session = store.openSession(host, fixture.buildId, 1).getValue("sessionId")
      assertArrayEquals(fixture.bytes, store.readAsset(session, "index.html").bytes)
      store.closeSession(session)
    }

    assertEquals(emptyList<String>(), failures)
    assertEquals(4, root.listFiles()?.size)
  }

  @Test
  fun repeatedCommitsOfOneGenerationConverge() {
    val root = temporary.newFolder("duplicate")
    val store = jvmMobileWebPackageStore(root)
    val fixture = mobileWebStoreFixture(content = "<title>same generation</title>")

    val commitFailures = runConcurrently(24) { store.commitFixture("same-host", fixture) }
    assertEquals(emptyList<String>(), commitFailures)

    val readFailures = runConcurrently(24) {
      val session = store.openSession("same-host", fixture.buildId, 1).getValue("sessionId")
      assertArrayEquals(fixture.bytes, store.readAsset(session, "index.html").bytes)
      store.closeSession(session)
    }
    assertEquals(emptyList<String>(), readFailures)
    val active = store.openSession("same-host", null, 1).getValue("sessionId")
    assertArrayEquals(fixture.bytes, store.readAsset(active, "index.html").bytes)
    assertTrue(File(mobileWebStoreHostRoot(root, "same-host"), "tmp").listFiles().isNullOrEmpty())
  }

  /** Competing commits for one host converge on exactly one generation, whichever wins the lock. */
  @Test
  fun competingGenerationsConvergeOnOne() {
    val root = temporary.newFolder("generations")
    val store = jvmMobileWebPackageStore(root)
    val fixtures = (0 until 16).map { mobileWebStoreFixture(content = "<title>generation-$it</title>") }

    val failures = runConcurrently(fixtures.size) { store.commitFixture("generation-host", fixtures[it]) }

    assertEquals(emptyList<String>(), failures)
    val retained = mobileWebStoreGenerations(root, "generation-host").listFiles()?.map { it.name }
    assertEquals(1, retained?.size)
    val active = store.openSession("generation-host", null, 1)
    assertEquals(retained?.single(), active["buildId"])
    val activeFixture = fixtures.single { it.buildId == active["buildId"] }
    assertArrayEquals(
      activeFixture.bytes,
      store.readAsset(active.getValue("sessionId"), "index.html").bytes
    )
  }

  @Test
  fun abortedStagesNeverBecomeGenerations() {
    val root = temporary.newFolder("commit-abort")
    val store = jvmMobileWebPackageStore(root)
    val fixtures = (0 until 16).map { mobileWebStoreFixture(content = "<title>stage-$it</title>") }
    fixtures.forEach { store.stageAsset("stage-host", it) }

    val failures = runConcurrently(fixtures.size) { index ->
      if (index % 2 == 0) {
        store.commitGeneration("stage-host", fixtures[index].buildId, fixtures[index].manifestJson)
      } else {
        store.abortGeneration("stage-host", fixtures[index].buildId)
      }
    }

    assertEquals(emptyList<String>(), failures)
    for (index in 1 until fixtures.size step 2) {
      assertThrows(IllegalArgumentException::class.java) {
        store.openSession("stage-host", fixtures[index].buildId, 1)
      }
    }
    val retained = mobileWebStoreGenerations(root, "stage-host").listFiles()?.map { it.name }
    assertEquals(1, retained?.size)
    assertTrue(
      fixtures.filterIndexed { index, _ -> index % 2 == 0 }.any { it.buildId == retained?.single() }
    )
    store.removeHost("stage-host")
    assertFalse(mobileWebStoreHostRoot(root, "stage-host").exists())
  }

  private fun runConcurrently(iterations: Int, body: (Int) -> Unit): List<String> {
    val failures = Collections.synchronizedList(mutableListOf<String>())
    val executor = Executors.newFixedThreadPool(8)
    try {
      (0 until iterations)
        .map { index -> executor.submit { runCatching { body(index) }.onFailure { failures += "$it" } } }
        .forEach { it.get(60, TimeUnit.SECONDS) }
    } finally {
      executor.shutdownNow()
    }
    return failures.toList()
  }
}
