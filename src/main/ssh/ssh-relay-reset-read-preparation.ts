import {
  captureSshResetRecoveryDestination,
  type SshResetRecoveryConnection
} from './ssh-reset-recovery-destination'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import { buildSshResetPreparationReadCommand } from './ssh-relay-reset-recovery-channel'
import { validateRelayResetPreparationRecord } from '../../shared/relay-reset-preparation-contract'

/** Caller retains target admission; transport identity is also checked against durable intent. */
export async function readSshResetPreparation(options: {
  intent: SshRelayResetIntent
  connection: SshResetRecoveryConnection
  signal: AbortSignal
  assertDestinationCurrent: () => void
}) {
  const intent = parseSshRelayResetIntent(options.intent)
  const command = buildSshResetPreparationReadCommand(intent)
  const assertTransport = captureSshResetRecoveryDestination(intent, options.connection)
  const input = JSON.stringify({ version: 1, binding: intent.preparation, request: intent.request })
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new Error('ssh_reset_preparation_read_request_too_large')
  }
  const assertCurrent = (): undefined => {
    options.signal.throwIfAborted()
    options.assertDestinationCurrent()
    assertTransport()
    options.signal.throwIfAborted()
  }
  assertCurrent()
  let stdout: string
  try {
    stdout = await execCommand(options.connection, command, {
      signal: options.signal,
      stdin: input,
      beforeInput: assertCurrent,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024
    })
  } catch (error) {
    // A hostile shell can echo stdin in stderr; never propagate that diagnostic payload.
    throw Object.assign(
      new Error('ssh_reset_preparation_read_unverifiable'),
      isUnconfirmedSshCommandTermination(error) ? { sshChannelCloseConfirmed: false } : {}
    )
  }
  assertCurrent()
  let value: { version?: unknown; preparation?: unknown } | null
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('ssh_reset_preparation_read_invalid')
  }
  if (!value || value.version !== 1 || !Object.hasOwn(value, 'preparation')) {
    throw new Error('ssh_reset_preparation_read_invalid')
  }
  const preparation =
    value.preparation === null
      ? null
      : validateRelayResetPreparationRecord(value.preparation, intent.preparation!, intent.request)
  assertCurrent()
  return { preparation, assertCurrent }
}
