package expo.modules.iroh

import android.util.Base64
import computer.iroh.BiStream
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointAddr
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.IrohException
import computer.iroh.PathSnapshot
import computer.iroh.presetN0
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private val ALPN = "orca-mobile-rpc/1".toByteArray()
private const val MAX_FRAME = 1 shl 20
private const val READ_CHUNK = 64 * 1024
private const val PATH_POLL_MS = 2_000L

class IrohClientException(code: String, message: String = code, cause: Throwable? = null) :
  CodedException(code, message, cause)

/**
 * Owns the local Endpoint and live dialed connections (one bi-stream each), mirroring the iOS
 * IrohClient. Framing: 4-byte big-endian u32 length + payload; max 1 MiB.
 */
class IrohClient(private val emit: (String, Map<String, Any?>) -> Unit) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Mutex()
  private var bind: Deferred<Endpoint>? = null
  private var endpoint: Endpoint? = null
  // stop() bumps this so a bind or dial that lands afterwards releases itself.
  private var generation = 0
  private val connections = ConcurrentHashMap<String, LiveConnection>()

  suspend fun start(): String = irohCall { ensureEndpoint().id().toString() }

  suspend fun connect(endpointId: String, relayUrl: String?, directAddresses: List<String>): String {
    val trimmed = endpointId.trim().lowercase()
    if (trimmed.length != 64 || !trimmed.all { it in '0'..'9' || it in 'a'..'f' }) {
      throw IrohClientException("iroh_invalid_endpoint_id")
    }
    val gen = lock.withLock { generation }
    // The dial runs in the client's scope so a cancelled caller cannot drop a connection
    // that already exists natively; the late result is closed instead.
    val dial = scope.async { irohCall { dial(gen, trimmed, relayUrl, directAddresses) } }
    try {
      return dial.await()
    } catch (e: CancellationException) {
      scope.launch { runCatching { close(dial.await()) } }
      throw e
    }
  }

  suspend fun send(connectionId: String, bytesBase64: String) {
    val live = connections[connectionId] ?: throw IrohClientException("iroh_unknown_connection")
    val payload = try {
      Base64.decode(bytesBase64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      throw IrohClientException("iroh_invalid_base64")
    }
    if (payload.size > MAX_FRAME) {
      throw IrohClientException("iroh_frame_too_large")
    }
    val frame = ByteBuffer.allocate(4 + payload.size).putInt(payload.size).put(payload).array()
    // JS sends are fire-and-forget; one write per frame under a FIFO lock keeps frames whole.
    irohCall { live.writeLock.withLock { live.send.writeAll(frame) } }
  }

  fun pathInfo(connectionId: String): Map<String, String> {
    val live = connections[connectionId] ?: throw IrohClientException("iroh_unknown_connection")
    val paths = live.connection.paths()
    return mapOf("pathType" to pathLabel(paths), "detail" to pathDetail(paths))
  }

  suspend fun close(connectionId: String) {
    connections.remove(connectionId)?.let { teardown(it, "closed") }
  }

  suspend fun stop() {
    val ep = lock.withLock {
      generation += 1
      bind = null
      endpoint.also { endpoint = null }
    }
    val lives = connections.values.toList()
    connections.clear()
    lives.forEach { teardown(it, "stopped") }
    // A bind still in flight sees the new generation and releases its own endpoint.
    ep?.let { release(it) }
  }

  fun destroy() {
    CoroutineScope(Dispatchers.IO).launch {
      withContext(NonCancellable) { stop() }
      scope.cancel()
    }
  }

  private suspend fun ensureEndpoint(): Endpoint {
    val task = lock.withLock {
      endpoint?.let { return it }
      bind ?: startBind(generation).also { bind = it }
    }
    return task.await()
  }

  // Called under lock. The bind owns its result: a stale generation releases the endpoint here,
  // since nobody else will. It does not wait for online(): that waits for a relay and would block
  // a QR's direct-address hints on an offline LAN.
  private fun startBind(gen: Int): Deferred<Endpoint> =
    scope.async {
      val ep = try {
        Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(ALPN)))
      } catch (e: Throwable) {
        lock.withLock { if (generation == gen) bind = null }
        throw e
      }
      val current = lock.withLock { (generation == gen).also { if (it) endpoint = ep } }
      if (!current) {
        release(ep)
        throw IrohClientException("iroh_not_started")
      }
      ep
    }

  private suspend fun dial(
    gen: Int,
    remote: String,
    relayUrl: String?,
    directAddresses: List<String>
  ): String {
    val ep = ensureEndpoint()
    // Pairing-supplied hints connect same-LAN peers without discovery and skip its round-trip.
    val addr = EndpointAddr(EndpointId.fromString(remote), relayUrl, directAddresses)
    val conn = ep.connect(addr, ALPN)
    val bi = try {
      conn.openBi()
    } catch (e: Throwable) {
      closeQuietly(conn, "open_bi_failed")
      conn.destroy()
      throw e
    }
    val live = LiveConnection(UUID.randomUUID().toString(), conn, bi)
    // Lazy so a job that drops the connection at once cannot race the registration below.
    live.jobs = listOf(
      scope.launch(start = CoroutineStart.LAZY) { readLoop(live) },
      scope.launch(start = CoroutineStart.LAZY) { pollPaths(live) },
      scope.launch(start = CoroutineStart.LAZY) {
        drop(live.id, live.connection.closed().ifEmpty { "closed" })
      }
    )
    val current = lock.withLock { (generation == gen).also { if (it) connections[live.id] = live } }
    if (!current) {
      teardown(live, "stopped", emitClosed = false)
      throw IrohClientException("iroh_not_started")
    }
    live.jobs.forEach(Job::start)
    return live.id
  }

  private suspend fun readLoop(live: LiveConnection) {
    val buffer = ByteArrayOutputStream()
    val reason = try {
      while (true) {
        val chunk = live.recv.read(READ_CHUNK.toUInt())
        if (chunk.isEmpty()) break
        buffer.write(chunk)
        drainFrames(buffer, live.id)
      }
      "stream_ended"
    } catch (e: CancellationException) {
      throw e
    } catch (e: Throwable) {
      // A peer close fails the read first; its reason carries the app close code (4001 auth).
      live.connection.closeReason() ?: describe(e)
    }
    drop(live.id, reason)
  }

  private fun drainFrames(buffer: ByteArrayOutputStream, connectionId: String) {
    val bytes = buffer.toByteArray()
    var offset = 0
    while (bytes.size - offset >= 4) {
      val length = ByteBuffer.wrap(bytes, offset, 4).int
      if (length < 0 || length > MAX_FRAME) throw IrohClientException("iroh_frame_too_large")
      if (bytes.size - offset - 4 < length) break
      val payload = bytes.copyOfRange(offset + 4, offset + 4 + length)
      offset += 4 + length
      emit("onMessage", mapOf("connectionId" to connectionId, "bytesBase64" to encode(payload)))
    }
    buffer.reset()
    buffer.write(bytes, offset, bytes.size - offset)
  }

  private suspend fun pollPaths(live: LiveConnection) {
    var last: Pair<String, String>? = null
    while (true) {
      val paths = live.connection.paths()
      val snapshot = pathLabel(paths) to pathDetail(paths)
      if (snapshot != last) {
        last = snapshot
        emit(
          "onPathChanged",
          mapOf("connectionId" to live.id, "pathType" to snapshot.first, "detail" to snapshot.second)
        )
      }
      delay(PATH_POLL_MS)
    }
  }

  // Runs on the connection's own jobs, so the teardown that cancels them gets its own coroutine.
  private fun drop(connectionId: String, reason: String) {
    val live = connections.remove(connectionId) ?: return
    scope.launch { teardown(live, reason) }
  }

  private suspend fun teardown(live: LiveConnection, reason: String, emitClosed: Boolean = true) {
    live.jobs.forEach(Job::cancel)
    closeQuietly(live.connection, reason)
    if (emitClosed) {
      emit("onClosed", mapOf("connectionId" to live.id, "reason" to reason))
    }
    // Waits for in-flight writes; uniffi defers the free until running calls return.
    live.writeLock.withLock {
      live.send.destroy()
      live.recv.destroy()
      live.bi.destroy()
      live.connection.destroy()
    }
  }

  // shutdown() closes the endpoint's sockets; destroy() only frees the FFI handle.
  private suspend fun release(ep: Endpoint) {
    withContext(NonCancellable) { runCatching { ep.shutdown() } }
    ep.destroy()
  }

  private fun closeQuietly(conn: Connection, reason: String) {
    runCatching { conn.close(0L, reason.toByteArray()) }
  }

  private suspend fun <T> irohCall(block: suspend () -> T): T =
    try {
      block()
    } catch (e: IrohException) {
      throw IrohClientException("iroh_error", describe(e), e)
    }

  private fun describe(e: Throwable): String =
    if (e is IrohException) e.message() else e.message ?: e.toString()

  private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

  private class LiveConnection(val id: String, val connection: Connection, val bi: BiStream) {
    val send = bi.send()
    val recv = bi.recv()
    val writeLock = Mutex()
    var jobs: List<Job> = emptyList()
  }
}

internal fun pathLabel(paths: List<PathSnapshot>): String {
  val selected = paths.firstOrNull { it.isSelected } ?: paths.firstOrNull() ?: return "unknown"
  return when {
    selected.isIp && selected.isRelay -> "mixed"
    selected.isIp -> "direct"
    selected.isRelay -> "relayed"
    else -> "unknown"
  }
}

internal fun pathDetail(paths: List<PathSnapshot>): String {
  if (paths.isEmpty()) return "(no paths yet)"
  return paths.joinToString("\n") { p ->
    val kind = listOfNotNull("IP".takeIf { p.isIp }, "RELAY".takeIf { p.isRelay }).joinToString("+")
    val mark = if (p.isSelected) "*" else " "
    "$mark $kind ${p.remoteAddr} rtt=${p.rttMs}ms"
  }
}
