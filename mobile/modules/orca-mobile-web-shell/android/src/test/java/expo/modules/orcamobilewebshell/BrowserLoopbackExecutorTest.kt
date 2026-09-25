package expo.modules.orcamobilewebshell

import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class BrowserLoopbackExecutorTest {
  private fun workers(proxy: BrowserLoopbackProxy): ThreadPoolExecutor {
    val field = proxy.javaClass.getDeclaredField("workers")
    field.isAccessible = true
    return field.get(proxy) as ThreadPoolExecutor
  }

  private fun <T> pending(start: ((Result<T>) -> Unit) -> Unit): CompletableFuture<T> {
    val result = CompletableFuture<T>()
    start { value -> value.fold({ result.complete(it) }, { result.completeExceptionally(it) }) }
    return result
  }

  @Test fun boundedQueueBridgesHeldCompletionsAndRetiresIdleWorkers() {
    BrowserLoopbackProxy().use { proxy ->
      val pool = workers(proxy)
      assertEquals(0, pool.poolSize)
      assertTrue(pool.allowsCoreThreadTimeOut())
      val release = CountDownLatch(1)
      val accepted = pending<Int> { proxy.accept(it) }
      Socket("127.0.0.1", proxy.port).use { client ->
        val id = accepted.get(2, TimeUnit.SECONDS)
        try {
          repeat(BrowserLoopbackProxy.MAX_OPERATIONS) {
            val completed = CountDownLatch(1)
            proxy.read(id) { result ->
              assertTrue(result.isSuccess)
              completed.countDown()
              release.await(10, TimeUnit.SECONDS)
            }
            client.getOutputStream().write(1)
            assertTrue(completed.await(2, TimeUnit.SECONDS))
          }
          val next = pending<ByteArray?> { proxy.read(id, it) }
          client.getOutputStream().write(2)
          assertFalse(next.isDone)
          assertEquals(1, pool.queue.size)
          assertEquals(BrowserLoopbackProxy.MAX_OPERATIONS - 1, pool.queue.remainingCapacity())
          assertThrows(IllegalStateException::class.java) { proxy.read(id) {} }
          release.countDown()
          assertArrayEquals(byteArrayOf(2), next.get(2, TimeUnit.SECONDS))
          pool.setKeepAliveTime(20, TimeUnit.MILLISECONDS)
          val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
          while (pool.poolSize > 0 && System.nanoTime() < deadline) Thread.sleep(5)
          assertEquals(0, pool.poolSize)
          val restarted = pending<ByteArray?> { proxy.read(id, it) }
          client.getOutputStream().write(3)
          assertArrayEquals(byteArrayOf(3), restarted.get(2, TimeUnit.SECONDS))
        } finally { release.countDown() }
      }
    }
  }

  @Test fun obsoleteQueuedOperationsSettleBeforeHeldWorkersReturn() {
    BrowserLoopbackProxy().use { proxy ->
      val release = CountDownLatch(1)
      val accepted = pending<Int> { proxy.accept(it) }
      Socket("127.0.0.1", proxy.port).use { client ->
        val id = accepted.get(2, TimeUnit.SECONDS)
        try {
          repeat(BrowserLoopbackProxy.MAX_OPERATIONS) {
            val completed = CountDownLatch(1)
            proxy.read(id) {
              completed.countDown()
              release.await(10, TimeUnit.SECONDS)
            }
            client.getOutputStream().write(1)
            assertTrue(completed.await(2, TimeUnit.SECONDS))
          }
          val read = pending<ByteArray?> { proxy.read(id, it) }
          val write = pending<Unit> { proxy.write(id, byteArrayOf(1), it) }
          assertEquals(2, workers(proxy).queue.size)
          proxy.closeSocket(id)
          assertThrows(Exception::class.java) { read.get(2, TimeUnit.SECONDS) }
          assertThrows(Exception::class.java) { write.get(2, TimeUnit.SECONDS) }
          assertEquals(0, workers(proxy).queue.size)
          val replacement = pending<Int> { proxy.accept(it) }
          Socket("127.0.0.1", proxy.port).use {
            release.countDown()
            assertNotEquals(id, replacement.get(2, TimeUnit.SECONDS))
          }
        } finally { release.countDown() }
      }
    }
  }

  @Test fun fullDuplexPeersAndRepeatedChurnDoNotRejectLegalOperations() {
    BrowserLoopbackProxy().use { proxy ->
      repeat(8) {
        val clients = mutableListOf<Pair<Int, Socket>>()
        try {
          repeat(BrowserLoopbackProxy.MAX_SOCKETS) {
            val accepted = pending<Int> { proxy.accept(it) }
            val client = Socket("127.0.0.1", proxy.port)
            client.soTimeout = 2000
            clients.add(accepted.get(2, TimeUnit.SECONDS) to client)
          }
          repeat(8) {
            val reads = clients.map { (id, _) -> pending<ByteArray?> { proxy.read(id, it) } }
            val writes = clients.map { (id, _) -> pending<Unit> { proxy.write(id, byteArrayOf(7), it) } }
            clients.forEach { (_, client) -> client.getOutputStream().write(9) }
            writes.forEach { it.get(2, TimeUnit.SECONDS) }
            reads.forEach { assertArrayEquals(byteArrayOf(9), it.get(2, TimeUnit.SECONDS)) }
            clients.forEach { (_, client) -> assertEquals(7, client.getInputStream().read()) }
          }
        } finally {
          clients.forEach { (id, client) -> proxy.closeSocket(id); client.close() }
        }
      }
      assertTrue(workers(proxy).largestPoolSize <= BrowserLoopbackProxy.MAX_OPERATIONS)
    }
  }
}
