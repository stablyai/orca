import type { LinearViewer, LinearWorkspace } from '../../shared/linear/workspace-types'
import { readApiKeyFromStdin } from '../arguments/stdin-api-key'
import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { describeRemoteServerSelection } from '../hosts/remote-server-selection'
import { linearConnectCommand } from './linear-not-connected-recovery'

// Hosts older than the multi-workspace registry answer with `viewer` only.
type LinearConnectResult =
  | { ok: true; viewer: LinearViewer; workspace?: LinearWorkspace }
  | { ok: false; error: string }

// Linear API keys are about 50 characters; the cap only stops a wrong file from being sent.
const LINEAR_API_KEY_MAX_LENGTH = 1024

// Same RPC as Settings > Integrations > Linear, so the key is saved on the host this command reached.
export const runLinearConnect: CommandHandler = async ({ client, flags, json }) => {
  const apiKey = await readApiKeyFromStdin({
    name: 'a Linear API key',
    pipeExample: linearConnectCommand(describeRemoteServerSelection(flags)?.flag),
    maxLength: LINEAR_API_KEY_MAX_LENGTH
  })
  const response = await client.call<LinearConnectResult>('linear.connect', { apiKey })
  if (!response.result.ok) {
    // The provider's error may quote what it was sent.
    const reason = response.result.error.split(apiKey).join('<key>')
    throw new RuntimeClientError('linear_connect_failed', `Could not connect Linear: ${reason}`)
  }
  // A host without a keyring (headless Linux) saves the key unsealed; Settings warns, so does this.
  // The key is already saved; a failed status read only loses the unsealed note.
  const status = json
    ? null
    : await client.call<{ credentialProtection?: string | null }>('linear.status').catch(() => null)
  const unsealed =
    status?.result.credentialProtection === 'plaintext'
      ? ' It is saved unencrypted: this host cannot seal secrets.'
      : ''
  printResult(response, json, (result) => {
    if (!result.ok) {
      return ''
    }
    const account = result.workspace ?? result.viewer
    return `Connected Linear workspace ${account.organizationName} as ${account.email ?? account.displayName} on the Orca host this command reached.${unsealed}`
  })
}
