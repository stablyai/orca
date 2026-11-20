import { useEffect, useState } from 'react'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import type { RpcCompatibleReader } from '../../transport/rpc/rpc-operation-contract'
import { settingsField, settingsMember } from '../../settings/mobile-settings-projection'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../src/shared/terminal/replay/terminal-scrollback-policy'
import { TERMINAL_DEFAULT_WORD_SEPARATOR } from '../../../../src/shared/terminal/input/terminal-word-separator'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { TerminalHostSettings } from '../webview/terminal-webview-messages'

// Desktop allows 50 000 rows; a phone WebView holds one buffer per open terminal, so it keeps at most 10 000.
export const MOBILE_TERMINAL_SCROLLBACK_ROWS_MAX = 10_000

const readTerminalHostSettings: RpcCompatibleReader<
  unknown,
  'terminal-host-settings',
  TerminalHostSettings
> = (raw) => {
  const settings = raw == null ? undefined : settingsMember(raw)
  const field = (key: string): unknown =>
    settings == null ? undefined : settingsField(settings, key)
  const wordSeparator = field('terminalWordSeparator')
  return {
    compatible: true,
    variant: 'terminal-host-settings',
    // Older hosts omit these settings; absence means desktop's defaults, as on desktop.
    value: {
      scrollbackRows: Math.min(
        normalizeDesktopTerminalScrollbackRows(field('terminalScrollbackRows')),
        MOBILE_TERMINAL_SCROLLBACK_ROWS_MAX
      ),
      wordSeparator:
        typeof wordSeparator === 'string' ? wordSeparator : TERMINAL_DEFAULT_WORD_SEPARATOR
    },
    salvage: { droppedPaths: [], droppedCount: 0 }
  }
}

export const terminalHostSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.terminal-host-settings-or-skip',
    method: 'settings.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: readTerminalHostSettings
  })
)

// Read once per connection, like the copy-gutter setting: the phone has no settings stream.
export function useTerminalHostSettings(
  client: RpcClient | null,
  connState: ConnectionState
): TerminalHostSettings | undefined {
  const [hostSettings, setHostSettings] = useState<TerminalHostSettings>()

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    void terminalHostSettingsRead
      .request(client)
      .then((response) => {
        const read = terminalHostSettingsRead.interpret(response)
        if (stale || !read.accepted) {
          return
        }
        setHostSettings((current) =>
          current?.scrollbackRows === read.value.scrollbackRows &&
          current.wordSeparator === read.value.wordSeparator
            ? current
            : read.value
        )
      })
      .catch(() => {
        // Keep the current settings when the host is unreachable.
      })
    return () => {
      stale = true
    }
  }, [client, connState])

  return hostSettings
}
