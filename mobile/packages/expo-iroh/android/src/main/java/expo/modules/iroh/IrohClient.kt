package expo.modules.iroh

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Base64
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointAddr
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.IrohAndroid
import computer.iroh.RecvStream
import computer.iroh.RelayMode
import computer.iroh.SendStream
import computer.iroh.presetN0
import java.net.URI
import java.util.UUID
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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class IrohClient(
  private val context: () -> Context,
  private val emit: (String, Map<String, Any>) -> Unit
) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Any()
  private val stopLock = Mutex()
  private var generation = 0L
  private var destroyed = false
  private var startTask: Deferred<Endpoint>? = null
  private var endpoint: Endpoint? = null
  private var homeRelayUrl: String? = null
  private val connections = mutableMapOf<String, LiveConnection>()
  private var connectivityManager: ConnectivityManager? = null
  private var defaultNetwork: Network? = null
  // iroh's Android netwatch is a no-op; rebinding also clears its cached DNS.
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      synchronized(lock) {
        if (destroyed || network == defaultNetwork) return
        defaultNetwork = network
        val epoch = generation
        scope.launch { stop(epoch) }
      }
    }

    override fun onLost(network: Network) {
      synchronized(lock) {
        if (destroyed || network != defaultNetwork) return
        defaultNetwork = null
        val epoch = generation
        scope.launch { stop(epoch) }
      }
    }
  }

  /** Bind the local endpoint, retiring the previous one if its home relay changes. */
  suspend fun start(relayUrl: String?): String {
    val selected = parseHomeRelayUrl(relayUrl)
    val startGeneration = withContext(NonCancellable) {
      stopLock.withLock {
        val changed = synchronized(lock) {
          check(!destroyed) { "iroh_not_started" }
          (homeRelayUrl != selected).also { homeRelayUrl = selected }
        }
        if (changed) stopLocked(null)
        synchronized(lock) { generation }
      }
    }
    currentCoroutineContext().ensureActive()
    val (bound, epoch) = ensureEndpoint(startGeneration)
    return synchronized(lock) {
      check(generation == epoch && endpoint === bound && !destroyed) { "iroh_not_started" }
      bound.id().use { it.toString() }
    }
  }

  /** Share one bind for this generation and dispose native results that arrive after stop. */
  private suspend fun ensureEndpoint(expectedGeneration: Long): Pair<Endpoint, Long> {
    val (task, epoch) = synchronized(lock) {
      check(!destroyed && generation == expectedGeneration) { "iroh_not_started" }
      val epoch = expectedGeneration
      val relayUrl = homeRelayUrl
      val task = startTask ?: scope.async(start = CoroutineStart.LAZY) {
        // Bind is local, and its owned FFI result must be consumed even during stop/destroy.
        withContext(NonCancellable) {
          val androidContext = context()
          watchDefaultNetwork(androidContext)
          IrohAndroid.installAndroidContext(androidContext)
          val options = EndpointOptions(preset = presetN0(), alpns = listOf(ALPN))
          val bound = try {
            if (relayUrl != null) {
              options.relayMode = try {
                RelayMode.customFromUrls(listOf(relayUrl))
              } catch (_: Exception) {
                throw IllegalArgumentException("iroh_invalid_relay_url")
              }
            }
            Endpoint.bind(options)
          } finally {
            options.destroy()
          }
          try {
            val current = synchronized(lock) {
              if (generation == epoch && !destroyed) {
                endpoint = bound
                true
              } else false
            }
            check(current) { "iroh_not_started" }
            bound
          } catch (error: Throwable) {
            try { bound.shutdown() } finally { bound.close() }
            throw error
          }
        }
      }.also { startTask = it }
      task to epoch
    }
    try {
      val bound = task.await()
      synchronized(lock) {
        check(generation == epoch && endpoint === bound && !destroyed) { "iroh_not_started" }
      }
      return bound to epoch
    } catch (error: Throwable) {
      synchronized(lock) { if (task.isCancelled && startTask === task) startTask = null }
      throw error
    }
  }

  /** Register once to retire the endpoint when Android's default network changes. */
  private fun watchDefaultNetwork(androidContext: Context) {
    synchronized(lock) {
      check(!destroyed) { "iroh_not_started" }
      if (connectivityManager != null) return
      val manager = androidContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      defaultNetwork = manager.activeNetwork
      manager.registerDefaultNetworkCallback(networkCallback)
      connectivityManager = manager
    }
  }

  /** Dial a peer with address hints and publish one bi-stream plus its lifecycle jobs. */
  suspend fun connect(endpointId: String, relayUrl: String?, addresses: List<String>): String {
    val connectGeneration = synchronized(lock) { generation }
    val id = endpointId.trim().lowercase()
    require(ENDPOINT_ID.matches(id)) { "iroh_invalid_endpoint_id" }
    val (bound, epoch) = ensureEndpoint(connectGeneration)
    var opened: String? = null
    try {
      // Consume native handles before honoring cancellation; UniFFI cannot free unlifted results.
      val result = withContext(NonCancellable) {
        val connection = EndpointId.fromString(id).use { remote ->
          EndpointAddr(remote, relayUrl, addresses).use { address -> bound.connect(address, ALPN) }
        }
        val live = try {
          connection.openBi().use { stream ->
            LiveConnection(UUID.randomUUID().toString(), connection, stream.send(), stream.recv())
          }
        } catch (error: Throwable) {
          try { connection.close(0, "open_bi_failed".toByteArray()) } finally { connection.close() }
          throw error
        }
        // Tasks cannot touch FFI handles until the entire connection is published.
        live.jobs = listOf(
          scope.launch(start = CoroutineStart.LAZY) { readFrames(live) },
          scope.launch(start = CoroutineStart.LAZY) { pollPaths(live) },
          scope.launch(start = CoroutineStart.LAZY) {
            try {
              val reason = withContext(NonCancellable) { connection.closed() }
              currentCoroutineContext().ensureActive()
              drop(live.id, reason.ifBlank { "closed" })
            } catch (error: CancellationException) {
              throw error
            } catch (error: Exception) {
              drop(live.id, error.message ?: "closed")
            }
          }
        )
        val current = synchronized(lock) {
          if (generation == epoch && endpoint === bound && !destroyed) {
            connections[live.id] = live
            true
          } else false
        }
        if (!current) {
          teardown(live, "stopped", notify = false)
          error("iroh_not_started")
        }
        opened = live.id
        live.jobs.forEach { it.start() }
        live.id
      }
      currentCoroutineContext().ensureActive()
      return result
    } catch (error: Throwable) {
      opened?.let { drop(it, "closed") }
      throw error
    }
  }

  /** Decode bridge base64 before applying the raw wire cap and serializing the framed write. */
  suspend fun send(id: String, base64: String) {
    val live = live(id)
    require(base64.length <= ((IrohFraming.MAX_PAYLOAD + 2) / 3) * 4) { "iroh_frame_too_large" }
    require(base64.length % 4 == 0 && BASE64.matches(base64)) { "iroh_invalid_base64" }
    val payload = try { Base64.decode(base64, Base64.NO_WRAP) } catch (error: IllegalArgumentException) {
      throw IllegalArgumentException("iroh_invalid_base64", error)
    }
    val header = IrohFraming.header(payload.size)
    live.writeLock.withLock {
      live.send.writeAll(header)
      if (payload.isNotEmpty()) live.send.writeAll(payload)
    }
  }

  fun pathInfo(id: String): Map<String, String> = snapshot(live(id))

  suspend fun close(id: String) { drop(id, "closed") }


  suspend fun stop() = stop(null)

  /** Serialize cancellation-safe cleanup, optionally ignoring an obsolete network generation. */
  private suspend fun stop(expectedGeneration: Long?) = withContext(NonCancellable) {
    // Serialize stop/destroy so scope cancellation cannot overtake an earlier bind cleanup.
    stopLock.withLock { stopLocked(expectedGeneration) }
  }

  /** Retire state under [stopLock], join any bind, then release connections and endpoint handles. */
  private suspend fun stopLocked(expectedGeneration: Long?) {
    val retired = synchronized(lock) {
      if (expectedGeneration != null && generation != expectedGeneration) return
      generation++
      val all = connections.values.toList()
      connections.clear()
      val bound = endpoint
      endpoint = null
      val task = startTask
      startTask = null
      Triple(all, bound, task)
    }
    // Join local bind so every native result is lifted; stale results close themselves.
    retired.third?.join()
    retired.first.forEach { teardown(it, "stopped") }
    retired.second?.let { bound -> try { bound.shutdown() } finally { bound.close() } }
  }

  /** Permanently reject new work, unregister network monitoring, and finish cleanup before cancellation. */
  fun destroy() {
    val manager = synchronized(lock) {
      if (destroyed) return
      destroyed = true
      connectivityManager.also { connectivityManager = null }
    }
    try {
      manager?.unregisterNetworkCallback(networkCallback)
    } finally {
      scope.launch {
        try { stop() } finally { scope.cancel() }
      }
    }
  }

  private fun live(id: String): LiveConnection = synchronized(lock) {
    connections[id] ?: error("iroh_unknown_connection")
  }

  /** Read bounded frames into base64 events; on failure, close using the peer's reason if available. */
  private suspend fun readFrames(live: LiveConnection) {
    try {
      while (currentCoroutineContext().isActive) {
        val header = withContext(NonCancellable) { live.recv.readExact(4u) }
        currentCoroutineContext().ensureActive()
        val length = IrohFraming.length(header)
        val payload = if (length == 0) ByteArray(0) else withContext(NonCancellable) {
          live.recv.readExact(length.toUInt())
        }
        currentCoroutineContext().ensureActive()
        emitIfAlive("onMessage", mapOf("connectionId" to live.id, "bytesBase64" to Base64.encodeToString(payload, Base64.NO_WRAP)))
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      // Preserve application close code 4001 for the JS authentication-rejection path.
      val reason = runCatching { live.connection.closeReason() }.getOrNull()
      drop(live.id, reason ?: error.message ?: "stream_ended")
    }
  }

  /** Poll path snapshots every two seconds, emitting only changes and dropping failed connections. */
  private suspend fun pollPaths(live: LiveConnection) {
    try {
      var previous: Map<String, String>? = null
      while (currentCoroutineContext().isActive) {
        val current = snapshot(live)
        if (current != previous) {
          previous = current
          emitIfAlive("onPathChanged", current + ("connectionId" to live.id))
        }
        delay(2_000)
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      drop(live.id, runCatching { live.connection.closeReason() }.getOrNull() ?: error.message ?: "closed")
    }
  }

  /** Label the selected path (or first available path) and describe all current routes. */
  private fun snapshot(live: LiveConnection): Map<String, String> {
    val paths = live.connection.paths()
    val selected = paths.firstOrNull { it.isSelected } ?: paths.firstOrNull()
    val type = when {
      selected?.isIp == true && selected.isRelay -> "mixed"
      selected?.isIp == true -> "direct"
      selected?.isRelay == true -> "relayed"
      else -> "unknown"
    }
    val detail = if (paths.isEmpty()) "(no paths yet)" else paths.joinToString("; ") {
      "${if (it.isSelected) "*" else ""}${if (it.isIp) "IP" else if (it.isRelay) "RELAY" else "UNKNOWN"} ${it.remoteAddr} RTT=${it.rttMs}ms"
    }
    return mapOf("pathType" to type, "detail" to detail)
  }

  /** Remove a connection before cleanup so competing close paths cannot tear it down twice. */
  private suspend fun drop(id: String, reason: String) {
    val live = synchronized(lock) { connections.remove(id) } ?: return
    teardown(live, reason)
  }

  /** Cancel lifecycle jobs and release native handles without cancellation, optionally emitting closure. */
  private suspend fun teardown(live: LiveConnection, reason: String, notify: Boolean = true) = withContext(NonCancellable) {
    live.jobs.forEach { it.cancel() }
    try {
      runCatching { live.connection.close(0, reason.toByteArray()) }
    } finally {
      live.send.close()
      live.recv.close()
      live.connection.close()
      if (notify) emitIfAlive("onClosed", mapOf("connectionId" to live.id, "reason" to reason))
    }
  }

  private fun emitIfAlive(event: String, body: Map<String, Any>) {
    synchronized(lock) { if (!destroyed) emit(event, body) }
  }

  private class LiveConnection(val id: String, val connection: Connection, val send: SendStream, val recv: RecvStream) {
    val writeLock = Mutex()
    var jobs: List<Job> = emptyList()
  }

  companion object {
    /** Normalize an HTTPS relay origin; blank selects the preset, while non-root URLs are rejected. */
    internal fun parseHomeRelayUrl(value: String?): String? {
      val selected = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
      val uri = try {
        URI(selected).parseServerAuthority()
      } catch (_: Exception) {
        throw IllegalArgumentException("iroh_invalid_relay_url")
      }
      require(
        uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() &&
          uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
          (uri.rawPath.isEmpty() || uri.rawPath == "/") && !uri.rawAuthority.endsWith(":") &&
          '%' !in uri.host && selected.none { it.isWhitespace() || it == '\\' } &&
          (uri.port == -1 || uri.port in 1..65535)
      ) { "iroh_invalid_relay_url" }
      val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
      return "https://${uri.host.lowercase()}$port/"
    }

    private val ALPN = "orca-mobile-rpc/1".toByteArray()
    private val ENDPOINT_ID = Regex("[0-9a-f]{64}")
    private val BASE64 = Regex("[A-Za-z0-9+/]*={0,2}")
  }
}
