import type { RelayDispatcher } from './dispatcher'

type RelayTerminalWatchOwners = {
  rootPath: string
  clients: Map<number, () => boolean>
  clientWatchIds: Map<number, number>
}

export function emitRelayWatcherTerminalFailure(
  dispatcher: RelayDispatcher,
  state: RelayTerminalWatchOwners,
  message: string
): void {
  for (const [clientId, isStale] of state.clients) {
    if (isStale()) {
      state.clients.delete(clientId)
      state.clientWatchIds.delete(clientId)
      continue
    }
    const watchId = state.clientWatchIds.get(clientId)
    if (watchId === undefined) {
      continue
    }
    // Why: a shared relay may serve multiple Orca clients; only owners of
    // this exact logical watch should invalidate their provider state.
    dispatcher.notifyClient(clientId, 'fs.watchFailed', {
      rootPath: state.rootPath,
      watchId,
      message
    })
  }
}
