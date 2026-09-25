package expo.modules.orcamobilewebshell

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class BrowserLoopbackDisposalTest {
  private class ThrowingSocket : Socket() {
    var closes = 0
    val reading = CountDownLatch(1)
    val release = CountDownLatch(1)
    override fun getInputStream(): InputStream = object : InputStream() {
      override fun read(): Int {
        reading.countDown()
        release.await(5, TimeUnit.SECONDS)
        return -1
      }
    }
    override fun getInetAddress(): InetAddress = InetAddress.getLoopbackAddress()
    override fun setTcpNoDelay(value: Boolean) {}
    override fun setReceiveBufferSize(value: Int) {}
    override fun setSendBufferSize(value: Int) {}
    override fun close() { closes++; throw IOException("socket close") }
  }

  @Test fun throwingListenerAndPeersStillReleaseAllResourcesExactlyOnce() {
    val sockets = List(3) { ThrowingSocket() }
    var next = 0
    var listenerCloses = 0
    val listener = object : ServerSocket() {
      override fun accept(): Socket = sockets[next++]
      override fun close() { listenerCloses++; throw IOException("listener close") }
    }
    val proxy = BrowserLoopbackProxy(listener)
    val ids = sockets.map {
      val accepted = CompletableFuture<Int>()
      proxy.accept { result -> result.fold({ accepted.complete(it) }, { accepted.completeExceptionally(it) }) }
      accepted.get(2, TimeUnit.SECONDS)
    }
    val reads = ids.map { id ->
      CompletableFuture<ByteArray?>().also { pending ->
        proxy.read(id) { result -> result.fold({ pending.complete(it) }, { pending.completeExceptionally(it) }) }
      }
    }
    sockets.forEach { assertTrue(it.reading.await(2, TimeUnit.SECONDS)) }
    proxy.closeSocket(ids.first())
    proxy.closeSocket(ids.first())
    proxy.close()
    proxy.close()
    reads.forEach { assertThrows(Exception::class.java) { it.get(2, TimeUnit.SECONDS) } }
    sockets.forEach { it.release.countDown() }
    assertEquals(1, listenerCloses)
    sockets.forEach { assertEquals(1, it.closes) }
    val field = proxy.javaClass.getDeclaredField("workers").apply { isAccessible = true }
    val pool = field.get(proxy) as ThreadPoolExecutor
    assertTrue(pool.isShutdown)
    assertTrue(pool.awaitTermination(2, TimeUnit.SECONDS))
    assertThrows(IllegalStateException::class.java) { proxy.read(ids.last()) {} }
  }

  @Test fun lateModuleCleanupIsHarmlessButResourceUseKeepsIdentityChecks() {
    val module = BrowserLoopbackModule()
    val proxy = BrowserLoopbackProxy()
    module.javaClass.getDeclaredField("proxy").apply { isAccessible = true }.set(module, proxy)
    module.javaClass.getDeclaredField("generation").apply { isAccessible = true }.setInt(module, 2)
    val owned = module.javaClass.getDeclaredMethod("owned", Int::class.javaPrimitiveType).apply { isAccessible = true }
    assertSame(proxy, owned.invoke(module, 2))
    module.closeSocket(1, 1)
    assertSame(proxy, owned.invoke(module, 2))
    assertThrows(java.lang.reflect.InvocationTargetException::class.java) { owned.invoke(module, 1) }
    val pending = CompletableFuture<Int>()
    proxy.accept { result -> result.fold({ pending.complete(it) }, { pending.completeExceptionally(it) }) }
    module.destroy()
    module.destroy()
    assertThrows(Exception::class.java) { pending.get(2, TimeUnit.SECONDS) }
    assertThrows(IllegalStateException::class.java) { module.start() }
    module.closeSocket(2, 1)
    module.closeSocket(1, 1)
    assertThrows(java.lang.reflect.InvocationTargetException::class.java) { owned.invoke(module, 2) }
  }
}
