import { posix, win32 } from 'node:path'
import type { ClientChannel } from 'ssh2'
import { isWindowsRelayPlatform } from '../../shared/relay-artifacts'
import {
  captureSshResetRecoveryDestination,
  type SshResetRecoveryConnection
} from './ssh-reset-recovery-destination'
import { shellEscape } from './ssh-connection-utils'
import { waitForSentinel } from './ssh-relay-deploy-helpers'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { RELAY_RESET_PREPARATION_READ_FLAG } from '../../shared/relay-reset-preparation-contract'

export function buildSshResetRecoveryConnectCommand(value: SshRelayResetIntent): string {
  return buildRecoveryCommand(value, false)
}

export function buildSshResetPreparationReadCommand(value: SshRelayResetIntent): string {
  if (parseSshRelayResetIntent(value).preparation?.readerVersion !== 1) {
    throw new Error('ssh_reset_preparation_reader_unavailable')
  }
  return buildRecoveryCommand(value, true)
}

function buildRecoveryCommand(value: SshRelayResetIntent, readPreparation: boolean): string {
  const { endpoint } = parseSshRelayResetIntent(value)
  const windows = isWindowsRelayPlatform(endpoint.relayPlatform)
  const absolute = (path: string) =>
    windows
      ? win32.isAbsolute(path) && (/^[a-z]:/i.test(path) || path.startsWith('\\\\'))
      : posix.isAbsolute(path)
  if (
    ![endpoint.relayDir, endpoint.runtimePath, endpoint.sockPath, endpoint.credentialFile].every(
      absolute
    )
  ) {
    throw new Error('ssh_reset_recovery_endpoint_not_absolute')
  }
  if (windows) {
    if (!endpoint.runtimePath.toLowerCase().endsWith('.exe')) {
      throw new Error('ssh_reset_recovery_runtime_not_executable')
    }
    return powerShellCommand(
      [
        `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(endpoint.relayDir)}`,
        ...(readPreparation
          ? [
              '$OrcaResetEncoding = [System.Text.UTF8Encoding]::new($false)',
              '[Console]::InputEncoding = $OrcaResetEncoding; [Console]::OutputEncoding = $OrcaResetEncoding; $OutputEncoding = $OrcaResetEncoding',
              '$OrcaResetInput = [Console]::In.ReadToEnd()',
              `$OrcaResetInput | & ${powerShellLiteral(endpoint.runtimePath)} 'relay.js' ${RELAY_RESET_PREPARATION_READ_FLAG}`
            ]
          : [
              `& ${powerShellLiteral(endpoint.runtimePath)} 'relay.js' --connect --sock-path ${powerShellLiteral(endpoint.sockPath)} --credential-file ${powerShellLiteral(endpoint.credentialFile)}`
            ]),
        'exit $LASTEXITCODE'
      ].join('; ')
    )
  }
  if (readPreparation) {
    return `cd ${shellEscape(endpoint.relayDir)} && ${shellEscape(endpoint.runtimePath)} relay.js ${RELAY_RESET_PREPARATION_READ_FLAG}`
  }
  return `cd ${shellEscape(endpoint.relayDir)} && ${shellEscape(endpoint.runtimePath)} relay.js --connect --sock-path ${shellEscape(endpoint.sockPath)} --credential-file ${shellEscape(endpoint.credentialFile)}`
}

/** Connect only: no status fallback, runtime discovery, deploy, credential rotation or daemon start. */
export async function openSshResetRecoveryChannel(options: {
  intent: SshRelayResetIntent
  connection: SshResetRecoveryConnection
  signal: AbortSignal
  /** Must bind the connected effective SSH destination, not only the saved target's alias. */
  assertDestinationCurrent: () => void
}) {
  const { connection, signal, assertDestinationCurrent } = options
  const command = buildSshResetRecoveryConnectCommand(options.intent)
  const assertTransport = captureSshResetRecoveryDestination(options.intent, connection)
  const assertCurrent = () => {
    signal.throwIfAborted()
    assertDestinationCurrent()
    assertTransport()
    signal.throwIfAborted()
  }
  assertCurrent()
  let channel: ClientChannel | undefined
  try {
    channel = await connection.exec(command, { signal })
    assertCurrent()
    const transport = await waitForSentinel(channel, signal)
    assertCurrent()
    return { transport, assertCurrent }
  } catch (error) {
    // The caller owns the SSH connection; only this attempted bridge belongs to us.
    try {
      channel?.close()
    } catch {
      /* Preserve the connection/handshake failure. */
    }
    throw error
  }
}
