package expo.modules.iroh

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoIrohModule : Module() {
  private val client = IrohClient(
    { requireNotNull(appContext.reactContext) { "iroh_not_started" }.applicationContext },
    { event, body -> sendEvent(event, body) }
  )
  override fun definition() = ModuleDefinition {
    Name("ExpoIroh")
    Events("onMessage", "onPathChanged", "onClosed")

    AsyncFunction("irohStart") Coroutine { homeRelayUrl: String? ->
      mapOf("endpointId" to client.start(homeRelayUrl))
    }
    AsyncFunction("irohConnect") Coroutine { endpointId: String, relayUrl: String?, addresses: List<String>? ->
      mapOf("connectionId" to client.connect(endpointId, relayUrl, addresses ?: emptyList()))
    }
    AsyncFunction("irohSend") Coroutine { id: String, bytesBase64: String ->
      client.send(id, bytesBase64)
    }
    AsyncFunction("irohPathInfo") { id: String -> client.pathInfo(id) }
    AsyncFunction("irohClose") Coroutine { id: String -> client.close(id) }
    AsyncFunction("irohStop") Coroutine { -> client.stop() }

    OnDestroy { client.destroy() }
  }
}
