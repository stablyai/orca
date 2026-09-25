package expo.modules.orcamobilewebshell

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.FutureTask
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Pull-only I/O: no worker may enqueue a second chunk while JS owns the first. */
internal class BrowserLoopbackProxy(
  private val listener: ServerSocket = ServerSocket(0, MAX_SOCKETS, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
) : AutoCloseable {
  companion object {
    const val CHUNK_BYTES = 16 * 1024
    const val MAX_SOCKETS = 32
    const val MAX_OPERATIONS = 1 + 2 * MAX_SOCKETS
  }

  private class Peer(val socket: Socket) {
    var reading = false
    var writing = false
  }

  private val lock = Any()
  // Grow before queuing: zero core threads would serialize blocking I/O.
  private val workers = ThreadPoolExecutor(
    MAX_OPERATIONS, MAX_OPERATIONS, 30, TimeUnit.SECONDS,
    ArrayBlockingQueue<Runnable>(MAX_OPERATIONS)
  ).apply { allowCoreThreadTimeOut(true) }
  private val operations = mutableMapOf<FutureTask<*>, Peer?>()
  private val peers = mutableMapOf<Int, Peer>()
  private var accepting = false
  private var closed = false
  private var nextId = 1
  val port: Int get() = listener.localPort

  fun accept(done: (Result<Int>) -> Unit) {
    synchronized(lock) {
      check(!closed && !accepting && peers.size < MAX_SOCKETS) { "Proxy accept unavailable" }
      accepting = true
    }
    execute(done, { synchronized(lock) { accepting = false } }) {
      val socket = listener.accept()
      try {
        synchronized(lock) {
          if (closed || !socket.inetAddress.isLoopbackAddress) {
            error("Proxy closed")
          }
          socket.tcpNoDelay = true
          socket.receiveBufferSize = CHUNK_BYTES
          socket.sendBufferSize = CHUNK_BYTES
          check(nextId < Int.MAX_VALUE) { "Proxy socket IDs exhausted" }
          val id = nextId++
          peers[id] = Peer(socket)
          id
        }
      } catch (error: Exception) {
        runCatching { socket.close() }
        throw error
      }
    }
  }

  fun read(id: Int, done: (Result<ByteArray?>) -> Unit) {
    val peer = claim(id, true)
    execute(done, { synchronized(lock) { peer.reading = false } }, peer) {
      val bytes = ByteArray(CHUNK_BYTES)
      val count = peer.socket.getInputStream().read(bytes)
      if (count < 0) null else if (count == bytes.size) bytes else bytes.copyOf(count)
    }
  }

  fun write(id: Int, bytes: ByteArray?, done: (Result<Unit>) -> Unit) {
    require(bytes == null || bytes.size in 1..CHUNK_BYTES) { "Proxy chunk exceeds limit" }
    val peer = claim(id, false)
    execute(done, { synchronized(lock) { peer.writing = false } }, peer) {
      if (bytes == null) peer.socket.shutdownOutput() else peer.socket.getOutputStream().write(bytes)
    }
  }

  private fun claim(id: Int, read: Boolean): Peer = synchronized(lock) {
    check(!closed) { "Proxy closed" }
    val peer = checkNotNull(peers[id]) { "Unknown proxy socket" }
    if (read) {
      check(!peer.reading) { "Proxy read already pending" }
      peer.reading = true
    } else {
      check(!peer.writing) { "Proxy write already pending" }
      peer.writing = true
    }
    peer
  }

  private fun <T> execute(
    done: (Result<T>) -> Unit, release: () -> Unit, peer: Peer? = null, action: () -> T
  ) {
    val task = object : FutureTask<Result<T>>({ runCatching(action) }) {
      override fun done() {
        synchronized(lock) { operations.remove(this) }
        release()
        val result = runCatching { get() }.fold({ it }, { Result.failure(it) })
        done(result)
      }
    }
    synchronized(lock) {
      if (closed || (peer != null && !peers.containsValue(peer))) {
        task.cancel(false)
        return
      }
      operations[task] = peer
      try { workers.execute(task) }
      catch (_: java.util.concurrent.RejectedExecutionException) { task.cancel(false) }
    }
  }

  private fun cancel(tasks: List<FutureTask<*>>) {
    tasks.forEach {
      workers.remove(it)
      runCatching { it.cancel(false) }
    }
  }

  fun closeSocket(id: Int) {
    val (peer, tasks) = synchronized(lock) {
      val peer = peers.remove(id) ?: return
      val tasks = operations.filterValues { it === peer }.keys.toList()
      // Free obsolete queue slots before a replacement peer can be admitted.
      tasks.forEach { workers.remove(it) }
      peer to tasks
    }
    runCatching { peer.socket.close() }
    cancel(tasks)
  }

  override fun close() {
    val (sockets, tasks) = synchronized(lock) {
      if (closed) return
      closed = true
      val sockets = peers.values.map { it.socket }
      peers.clear()
      sockets to operations.keys.toList()
    }
    runCatching { listener.close() }
    sockets.forEach { runCatching { it.close() } }
    cancel(tasks)
    workers.shutdown()
  }
}
