import { useMemo } from 'react'
import { usePageBridgeClientIfPresent } from '../../transport/connection/client-context.web'
import {
  BRIDGE_DIALOG_VERB,
  dialogShowResultSchema
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-dialog-verb'
import type { ShellDialogs } from './shell-dialogs-contract'

// Null on an older shell, an ungranted route or outside the shell, so the page keeps drawing its own; any refusal draws too.
export function useShellDialogs(): ShellDialogs | null {
  const client = usePageBridgeClientIfPresent()
  return useMemo(() => {
    if (client?.getShellSession()?.grants.native.includes(BRIDGE_DIALOG_VERB) !== true) {
      return null
    }
    return {
      show: async (params) =>
        dialogShowResultSchema.parse(
          (await client.callNativeVerb(BRIDGE_DIALOG_VERB, params)).result
        ),
      dismiss: async (token) => {
        await client.callNativeVerb(BRIDGE_DIALOG_VERB, { action: 'dismiss', token })
      }
    }
  }, [client])
}
