package expo.modules.mobilewebshell

import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * A killed process must never leave a half-published generation behind: the next launch either sees
 * the previous generation or the fully renamed new one, and never a staged tree.
 */
object MobileWebPackageStoreProcessInterruptionMain {
  private const val CHILD_FLAG = "--child"
  private const val HOST_IDENTITY = "paired-host"
  private val phases = listOf("asset-staged", "generation-committed")

  @JvmStatic
  fun main(args: Array<String>) {
    if (args.firstOrNull() == CHILD_FLAG) {
      runChild(File(args[1]), args[2])
      return
    }
    val root = Files.createTempDirectory("orca-mobile-web-store-process-").toFile()
    try {
      phases.forEach { phase -> verifyPhase(File(root, phase), phase) }
    } finally {
      root.deleteRecursively()
    }
  }

  private fun verifyPhase(root: File, phase: String) {
    require(root.mkdirs())
    val baseline = mobileWebStoreFixture("<!doctype html><title>Baseline</title>")
    val next = mobileWebStoreFixture("<!doctype html><title>Next</title>")
    jvmMobileWebPackageStore(root).commitFixture(HOST_IDENTITY, baseline)
    val marker = File(root, "ready-$phase")
    val process = ProcessBuilder(
      javaExecutable(),
      "-cp",
      System.getProperty("java.class.path"),
      MobileWebPackageStoreProcessInterruptionMain::class.java.name,
      CHILD_FLAG,
      root.absolutePath,
      phase
    )
      .redirectError(ProcessBuilder.Redirect.INHERIT)
      .redirectOutput(ProcessBuilder.Redirect.INHERIT)
      .start()
    waitForMarker(process, marker)
    process.destroyForcibly()
    require(process.waitFor(10, TimeUnit.SECONDS)) { "child did not terminate: $phase" }
    marker.delete()

    val reopened = jvmMobileWebPackageStore(root)
    val expected = if (phase == "generation-committed") next else baseline
    val active = reopened.openSession(HOST_IDENTITY, null, 1)
    require(active["buildId"] == expected.buildId) { "unexpected generation after $phase" }
    require(
      reopened.readAsset(active.getValue("sessionId"), "index.html").bytes
        .contentEquals(expected.bytes)
    ) { "unexpected asset after $phase" }
    require(!File(mobileWebStoreHostRoot(root, HOST_IDENTITY), "tmp").exists()) {
      "staged tree survived $phase"
    }
  }

  private fun runChild(root: File, phase: String) {
    require(phase in phases)
    val store = jvmMobileWebPackageStore(root)
    val next = mobileWebStoreFixture("<!doctype html><title>Next</title>")
    store.writeStagedAsset(
      HOST_IDENTITY,
      next.buildId,
      "index.html",
      Base64.getEncoder().encodeToString(next.bytes)
    )
    markReadyAndWait(root, phase, "asset-staged")
    store.commitGeneration(HOST_IDENTITY, next.buildId, next.manifestJson)
    markReadyAndWait(root, phase, "generation-committed")
    error("unknown interruption phase")
  }

  private fun markReadyAndWait(root: File, selected: String, current: String) {
    if (selected != current) return
    File(root, "ready-$selected").writeText("ready")
    while (true) {
      Thread.sleep(60_000)
    }
  }

  private fun waitForMarker(process: Process, marker: File) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    while (!marker.isFile && process.isAlive && System.nanoTime() < deadline) {
      Thread.sleep(10)
    }
    val childState = if (process.isAlive) "alive" else "exit ${process.exitValue()}"
    require(marker.isFile) { "child failed before interruption: $childState" }
  }

  private fun javaExecutable(): String {
    val executable =
      if (System.getProperty("os.name").orEmpty().startsWith("Windows")) "java.exe" else "java"
    return File(System.getProperty("java.home"), "bin/$executable").absolutePath
  }
}
