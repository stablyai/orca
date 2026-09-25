package expo.modules.orcamobilewebshell

import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class BrowserLoopbackProxyTest {
  private fun <T> pending(start: ((Result<T>) -> Unit) -> Unit): CompletableFuture<T> {
    val result = CompletableFuture<T>()
    start { value -> value.fold({ result.complete(it) }, { result.completeExceptionally(it) }) }
    return result
  }

  @Test fun loopbackBytesHalfCloseAndDisposal() {
    BrowserLoopbackProxy().use { proxy ->
      val accepted = pending<Int> { proxy.accept(it) }
      Socket("127.0.0.1", proxy.port).use { client ->
        client.soTimeout = 2000
        val id = accepted.get(2, TimeUnit.SECONDS)
        val first = pending<ByteArray?> { proxy.read(id, it) }
        assertThrows(IllegalStateException::class.java) { proxy.read(id) {} }
        client.getOutputStream().write(byteArrayOf(0, -1, 5))
        assertArrayEquals(byteArrayOf(0, -1, 5), first.get(2, TimeUnit.SECONDS))
        pending<Unit> { proxy.write(id, byteArrayOf(9, 8), it) }.get(2, TimeUnit.SECONDS)
        assertEquals(9, client.getInputStream().read())
        assertEquals(8, client.getInputStream().read())
        pending<Unit> { proxy.write(id, null, it) }.get(2, TimeUnit.SECONDS)
        assertEquals(-1, client.getInputStream().read())
        client.getOutputStream().write(byteArrayOf(7))
        assertArrayEquals(byteArrayOf(7), pending<ByteArray?> { proxy.read(id, it) }.get(2, TimeUnit.SECONDS))
        client.shutdownOutput()
        assertNull(pending<ByteArray?> { proxy.read(id, it) }.get(2, TimeUnit.SECONDS))
        proxy.closeSocket(id)
        assertThrows(IllegalStateException::class.java) { proxy.read(id) {} }
      }
    }
  }

  @Test fun boundedReadsAndCloseUnblocksWorkers() {
    val proxy = BrowserLoopbackProxy()
    val accepted = pending<Int> { proxy.accept(it) }
    Socket("127.0.0.1", proxy.port).use { client ->
      val id = accepted.get(2, TimeUnit.SECONDS)
      assertThrows(IllegalArgumentException::class.java) {
        proxy.write(id, ByteArray(BrowserLoopbackProxy.CHUNK_BYTES + 1)) {}
      }
      client.getOutputStream().write(ByteArray(BrowserLoopbackProxy.CHUNK_BYTES + 17))
      val bytes = pending<ByteArray?> { proxy.read(id, it) }.get(2, TimeUnit.SECONDS)!!
      assertTrue(bytes.size <= BrowserLoopbackProxy.CHUNK_BYTES)
      var remaining = BrowserLoopbackProxy.CHUNK_BYTES + 17 - bytes.size
      while (remaining > 0) remaining -= pending<ByteArray?> { proxy.read(id, it) }.get(2, TimeUnit.SECONDS)!!.size
      val blockedRead = pending<ByteArray?> { proxy.read(id, it) }
      val blockedAccept = pending<Int> { proxy.accept(it) }
      proxy.close()
      assertThrows(Exception::class.java) { blockedRead.get(2, TimeUnit.SECONDS) }
      assertThrows(Exception::class.java) { blockedAccept.get(2, TimeUnit.SECONDS) }
      proxy.close()
    }
  }

  @Test fun stalledWriterRejectsAnotherWriteAndDisposes() {
    BrowserLoopbackProxy().use { proxy ->
      val accepted = pending<Int> { proxy.accept(it) }
      Socket().use { client ->
        client.receiveBufferSize = 1024
        client.connect(java.net.InetSocketAddress("127.0.0.1", proxy.port))
        val id = accepted.get(2, TimeUnit.SECONDS)
        var stalled: CompletableFuture<Unit>? = null
        for (attempt in 0 until 1024) {
          val write = pending<Unit> { proxy.write(id, ByteArray(BrowserLoopbackProxy.CHUNK_BYTES), it) }
          try { write.get(20, TimeUnit.MILLISECONDS) }
          catch (_: java.util.concurrent.TimeoutException) { stalled = write; break }
        }
        assertNotNull("Loopback peer must apply backpressure", stalled)
        assertThrows(IllegalStateException::class.java) { proxy.write(id, byteArrayOf(1)) {} }
        proxy.closeSocket(id)
        assertThrows(Exception::class.java) { stalled!!.get(2, TimeUnit.SECONDS) }
      }
    }
  }

  @Test fun socketLimitAndSingleAccept() {
    BrowserLoopbackProxy().use { proxy ->
      val clients = mutableListOf<Socket>()
      try {
        repeat(BrowserLoopbackProxy.MAX_SOCKETS) {
          val accepted = pending<Int> { proxy.accept(it) }
          assertThrows(IllegalStateException::class.java) { proxy.accept {} }
          clients.add(Socket("127.0.0.1", proxy.port))
          accepted.get(2, TimeUnit.SECONDS)
        }
        assertThrows(IllegalStateException::class.java) { proxy.accept {} }
      } finally { clients.forEach { it.close() } }
    }
  }
}
