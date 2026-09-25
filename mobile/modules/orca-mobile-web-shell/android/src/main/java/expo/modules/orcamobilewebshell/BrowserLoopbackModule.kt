package expo.modules.orcamobilewebshell

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinitionBuilder

internal class BrowserLoopbackModule {
  private var proxy: BrowserLoopbackProxy? = null
  private var generation = 0
  private var destroyed = false

  private fun owned(route: Int): BrowserLoopbackProxy = synchronized(this) {
    check(route == generation) { "Obsolete proxy route" }
    checkNotNull(proxy) { "Proxy route closed" }
  }

  fun install(builder: ModuleDefinitionBuilder) = with(builder) {
    AsyncFunction("browserProxyStart") { start() }
    AsyncFunction("browserProxyAccept") { route: Int, promise: Promise ->
      owned(route).accept { settle(promise, it) }
    }
    AsyncFunction("browserProxyRead") { route: Int, socket: Int, promise: Promise ->
      owned(route).read(socket) { settle(promise, it) }
    }
    AsyncFunction("browserProxyWrite") { route: Int, socket: Int, bytes: ByteArray?, promise: Promise ->
      owned(route).write(socket, bytes) { result -> settle(promise, result.map { null }) }
    }
    Function("browserProxyCloseSocket") { route: Int, socket: Int ->
      closeSocket(route, socket)
    }
    Function("browserProxyClose") { route: Int ->
      synchronized(this@BrowserLoopbackModule) {
        if (route == generation) close()
      }
    }
    OnDestroy { destroy() }
  }

  @Synchronized
  internal fun start(): Map<String, Int> {
    check(!destroyed && proxy == null) { "Proxy route unavailable" }
    val created = BrowserLoopbackProxy()
    proxy = created
    generation += 1
    return mapOf("route" to generation, "port" to created.port)
  }

  @Synchronized
  internal fun destroy() {
    destroyed = true
    close()
  }

  @Synchronized
  internal fun closeSocket(route: Int, socket: Int) {
    if (route == generation) proxy?.closeSocket(socket)
  }

  @Synchronized
  private fun close() {
    val closing = proxy
    proxy = null
    closing?.close()
  }

  private fun <T> settle(promise: Promise, result: Result<T>) {
    result.fold({ promise.resolve(it) }, { promise.reject("ERR_BROWSER_PROXY", it.message, it) })
  }
}
