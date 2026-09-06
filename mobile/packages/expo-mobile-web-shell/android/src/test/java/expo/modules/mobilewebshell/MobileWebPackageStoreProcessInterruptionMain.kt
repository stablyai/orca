package expo.modules.mobilewebshell

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit

object MobileWebPackageStoreProcessInterruptionMain {
  private const val CHILD_FLAG = "--child"
  private const val HOST_IDENTITY = "paired-host"
  private val phases = listOf(
    "stage-created",
    "chunk-written",
    "asset-finished",
    "generation-committed",
    "activation-replaced"
  )

  @JvmStatic
  fun main(args: Array<String>) {
    if (args.firstOrNull() == CHILD_FLAG) {
      runChild(File(args[1]), args[2])
      return
    }
    val root = java.nio.file.Files.createTempDirectory("orca-mobile-web-store-process-").toFile()
    try {
      phases.forEach { phase -> verifyPhase(File(root, phase), phase) }
    } finally {
      root.deleteRecursively()
    }
  }

  private fun verifyPhase(root: File, phase: String) {
    require(root.mkdirs())
    val baseline = fixture("<!doctype html><title>Baseline</title>")
    val next = fixture("<!doctype html><title>Next</title>")
    val store = store(root)
    stage(store, baseline)
    val baselineSession = store.openSession(HOST_IDENTITY, baseline.buildId, 1)
    store.markSessionHealthy(baselineSession.getValue("sessionId"))
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
    require(!process.isAlive) { "child remained alive: $phase" }
    marker.delete()

    val reopened = store(root)
    val active = reopened.openSession(HOST_IDENTITY, null, 1)
    if (phase == "activation-replaced") {
      require(active["buildId"] == next.buildId)
      val recovered = reopened.recoverSession(active.getValue("sessionId"))
      require(recovered["buildId"] == baseline.buildId)
    } else {
      require(active["buildId"] == baseline.buildId)
    }
    val staging = File(root, "${processSha256(HOST_IDENTITY.toByteArray())}/staging")
    require(staging.listFiles()?.isNotEmpty() != true)
  }

  private fun runChild(root: File, phase: String) {
    require(phase in phases)
    val store = store(root)
    val next = fixture("<!doctype html><title>Next</title>")
    val stageId = store.beginStage(HOST_IDENTITY, next.manifest, next.canonical)
    markReadyAndWait(root, phase, "stage-created")
    store.writeAssetChunk(
      stageId,
      "index.html",
      0,
      Base64.getEncoder().encodeToString(next.bytes),
      processSha256(next.bytes)
    )
    markReadyAndWait(root, phase, "chunk-written")
    store.finishAsset(stageId, "index.html")
    markReadyAndWait(root, phase, "asset-finished")
    store.commitStage(stageId)
    markReadyAndWait(root, phase, "generation-committed")
    val session = store.openSession(HOST_IDENTITY, next.buildId, 1)
    store.markSessionHealthy(session.getValue("sessionId"))
    markReadyAndWait(root, phase, "activation-replaced")
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

  private fun stage(store: MobileWebPackageStore, fixture: ProcessFixture) {
    val stageId = store.beginStage(HOST_IDENTITY, fixture.manifest, fixture.canonical)
    store.writeAssetChunk(
      stageId,
      "index.html",
      0,
      Base64.getEncoder().encodeToString(fixture.bytes),
      processSha256(fixture.bytes)
    )
    store.finishAsset(stageId, "index.html")
    store.commitStage(stageId)
  }

  private fun fixture(content: String): ProcessFixture {
    val bytes = content.toByteArray()
    val asset = JSONObject()
      .put("path", "index.html")
      .put("sha256", processSha256(bytes))
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
    val buildId = processSha256(canonical.toByteArray())
    val manifest = JSONObject(canonical).put("buildId", buildId).toString()
    return ProcessFixture(bytes, canonical, manifest, buildId)
  }

  private fun store(root: File): MobileWebPackageStore =
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

  private fun javaExecutable(): String {
    val executable =
      if (System.getProperty("os.name").orEmpty().startsWith("Windows")) "java.exe" else "java"
    return File(System.getProperty("java.home"), "bin/$executable").absolutePath
  }
}

private data class ProcessFixture(
  val bytes: ByteArray,
  val canonical: String,
  val manifest: String,
  val buildId: String
)

private fun processSha256(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
