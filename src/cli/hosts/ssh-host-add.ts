import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import {
  SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY,
  type SshEditableTargetAddResult,
  type SshEditableTargetInput
} from '../../shared/remote-runtime/ssh/ssh-target-management'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'

export const SSH_HOST_ADD_HANDLERS: Record<string, CommandHandler> = {
  'host add': async ({ client, flags, json }) => {
    const target: SshEditableTargetInput = {
      label: getRequiredStringFlag(flags, 'name'),
      host: getRequiredStringFlag(flags, 'hostname'),
      username: getRequiredStringFlag(flags, 'user'),
      port: getOptionalPositiveIntegerFlag(flags, 'port') ?? 22,
      identityFile: getPresentStringFlag(flags, 'identity-file'),
      jumpHost: getPresentStringFlag(flags, 'jump-host'),
      proxyCommand: getPresentStringFlag(flags, 'proxy-command')
    }
    if (target.port > 65_535) {
      throw new RuntimeClientError('invalid_argument', '--port must be between 1 and 65535')
    }
    const status = await client.call<RuntimeStatus>('status.get')
    if (!status.result.capabilities?.includes(SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the selected runtime to add SSH hosts from the CLI.'
      )
    }
    const response = await client.call<SshEditableTargetAddResult>('ssh.addTarget', { target })
    const saved = response.result.target
    const host = {
      kind: 'ssh' as const,
      name: saved.label,
      id: saved.id,
      selector: `--host ssh:${saved.id}`
    }
    printResult(
      { ...response, result: { host } },
      json,
      ({ host: added }) => `Added SSH target ${added.name} (${added.id}). Use ${added.selector}.`
    )
  }
}
