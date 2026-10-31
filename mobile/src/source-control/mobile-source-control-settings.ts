import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from '../../../src/shared/source-control-group-order'
import {
  sourceControlSettingsRead,
  type MobileSourceControlSettings
} from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

const DESKTOP_DEFAULTS: MobileSourceControlSettings = {
  groupOrder: DEFAULT_SOURCE_CONTROL_GROUP_ORDER,
  compareAgainstUpstream: false,
  diffShowWhitespace: false
}

type ClientSettings = {
  settings: MobileSourceControlSettings
  inFlight: Promise<void> | null
  listeners: Set<() => void>
}

// One copy per host client, so every screen sees a reread; a new host starts from desktop's defaults.
const settingsByClient = new WeakMap<RpcClient, ClientSettings>()

function clientSettings(client: RpcClient): ClientSettings {
  let entry = settingsByClient.get(client)
  if (!entry) {
    entry = { settings: DESKTOP_DEFAULTS, inFlight: null, listeners: new Set() }
    settingsByClient.set(client, entry)
  }
  return entry
}

function rereadSettings(client: RpcClient): void {
  const entry = clientSettings(client)
  if (entry.inFlight) {
    return
  }
  entry.inFlight = sourceControlSettingsRead
    .request(client)
    .then((response) => {
      const reply = sourceControlSettingsRead.interpret(response)
      if (reply.accepted) {
        entry.settings = reply.value
        entry.listeners.forEach((listener) => listener())
      }
    })
    .catch(() => {
      // Keep the last settings when the host is unreachable.
    })
    .finally(() => {
      entry.inFlight = null
    })
}

// Desktop's Source Control and diff settings, reread when a screen mounts, on reconnect and on reload; mobile has no settings stream.
export function useMobileSourceControlSettings(
  client: RpcClient | null,
  connState: ConnectionState
): { settings: MobileSourceControlSettings; reload: () => void } {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!client) {
        return () => {}
      }
      const { listeners } = clientSettings(client)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    [client]
  )
  const settings = useSyncExternalStore(subscribe, () =>
    client ? clientSettings(client).settings : DESKTOP_DEFAULTS
  )
  useEffect(() => {
    if (client && connState === 'connected') {
      rereadSettings(client)
    }
  }, [client, connState])
  const reload = useCallback(() => {
    if (client && connState === 'connected') {
      rereadSettings(client)
    }
  }, [client, connState])
  return { settings, reload }
}
