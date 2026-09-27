package expo.modules.orcasshtunnel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import sshtunnel.Sshtunnel
import sshtunnel.Tunnel

class OrcaSshTunnelModule : Module() {
  private val tunnels = ConcurrentHashMap<String, Tunnel>()

  override fun definition() = ModuleDefinition {
    Name("OrcaSshTunnel")

    Function("create") {
      check(tunnels.size < 16) { "SSH_TUNNEL_LIMIT" }
      val id = UUID.randomUUID().toString()
      tunnels[id] = Sshtunnel.newTunnel()
      id
    }
    AsyncFunction("open") { id: String, config: String ->
      val tunnel = tunnels[id] ?: error("SSH_CANCELLED")
      tunnel.open(config)
    }
    AsyncFunction("probe") { id: String, config: String ->
      val tunnel = tunnels[id] ?: error("SSH_CANCELLED")
      tunnel.probe(config)
    }
    Function("close") { id: String -> tunnels.remove(id)?.close(); Unit }
    OnDestroy {
      tunnels.values.forEach { it.close() }
      tunnels.clear()
    }
  }
}
