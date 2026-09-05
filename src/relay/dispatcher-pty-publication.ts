import type { SinkWriteSettlement } from './dispatcher-client-writer'
import type { JsonRpcNotification } from './protocol'
import { RelayDispatcherProducerCapacity } from './dispatcher-producer-capacity'

export abstract class RelayDispatcherPtyPublication extends RelayDispatcherProducerCapacity {
  tryNotifyPtyData(
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'pty.data',
      params
    }
    return this.tryPublishToClients(
      this.activeClients().filter((client) => this.admitsPtyDataPublication(client.id, params)),
      msg,
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  tryNotifyPtyDataToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients().filter(
        (client) => matchesClient(client.id) && this.admitsPtyDataPublication(client.id, params)
      ),
      { jsonrpc: '2.0', method: 'pty.data', params },
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  projectPtyDataToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.projectToClients(
      this.activeClients().filter(
        (client) => matchesClient(client.id) && this.admitsPtyDataPublication(client.id, params)
      ),
      { jsonrpc: '2.0', method: 'pty.data', params },
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  tryNotifyPtyDataToClient(
    clientId: number,
    params: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    if (!this.admitsPtyDataPublication(clientId, params)) {
      onSettled({ ok: false, error: new Error('PTY publication is not admitted') })
      return false
    }
    return this.publishToClient(
      client,
      { jsonrpc: '2.0', method: 'pty.data', params },
      'ordinary',
      onSettled
    )
  }

  tryNotifyPtyExit(params: Record<string, unknown>): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients(),
      {
        jsonrpc: '2.0',
        method: 'pty.exit',
        params
      },
      'ordinary'
    )
  }

  tryNotifyPtyExitToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary'
    )
  }

  projectPtyExitToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.projectToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary'
    )
  }

  tryNotifyPtyExitToClient(
    clientId: number,
    params: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    return this.publishToClient(
      client,
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary',
      onSettled
    )
  }
}
