package expo.modules.iroh

import computer.iroh.IrohAndroid
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoIrohModule : Module() {
  private val client = IrohClient { name, body -> sendEvent(name, body) }

  override fun definition() = ModuleDefinition {
    Name("ExpoIroh")
    Events("onMessage", "onPathChanged", "onClosed")

    OnCreate {
      val context = requireNotNull(appContext.reactContext).applicationContext
      IrohAndroid.installAndroidContext(context)
    }
    OnDestroy { client.destroy() }

    AsyncFunction("irohStart") Coroutine { ->
      mapOf("endpointId" to client.start())
    }
    AsyncFunction("irohConnect") Coroutine { id: String, relay: String?, addresses: List<String>? ->
      mapOf("connectionId" to client.connect(id, relay, addresses.orEmpty()))
    }
    AsyncFunction("irohSend") Coroutine { id: String, payload: String -> client.send(id, payload) }
    AsyncFunction("irohPathInfo") Coroutine { id: String -> client.pathInfo(id) }
    AsyncFunction("irohClose") Coroutine { id: String -> client.close(id) }
    AsyncFunction("irohStop") Coroutine { -> client.stop() }
  }
}
