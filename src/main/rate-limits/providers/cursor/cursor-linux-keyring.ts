import { runProcess } from '@orca/process-host'
import { secretServiceProcessEnvironment } from '../../../linux-secret-service/session-bus-environment'

// cursor-agent's Secret Service item: service "<domain>-credentials", account "<domain>-user", domain "cursor".
const ITEM_ATTRIBUTES = ['service', 'cursor-credentials', 'account', 'cursor-user']

export type CursorLinuxKeyringRead =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; secret: string }

const READ_ERROR = 'Unable to read the Cursor login from the Linux keyring'
const LOCKED_ERROR =
  "Orca couldn't read the Cursor login from your Linux keyring (locked or access not granted)."

/** Returns cursor-agent's stored credentials JSON without asking the keyring to unlock. */
export async function readCursorLinuxKeyringSecret(): Promise<CursorLinuxKeyringRead> {
  try {
    // `lookup` unlocks locked items, prompting on every background refresh; `search` without --unlock
    // does not. KeePassXC can still ask to unlock its database before a search; with confirm-access on,
    // it reports an unapproved item as locked rather than prompting.
    const result = await runProcess({
      program: 'secret-tool',
      args: ['search', ...ITEM_ATTRIBUTES],
      env: await secretServiceProcessEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
      return { status: 'error', error: READ_ERROR }
    }
    const secret = /^secret = (.*)$/m.exec(result.stdout)?.[1]
    if (secret !== undefined) {
      return { status: 'ok', secret }
    }
    // A matched item prints without its secret while it is locked or access was not granted.
    return /^\[/m.test(result.stdout)
      ? { status: 'error', error: LOCKED_ERROR }
      : { status: 'missing' }
  } catch {
    // Spawn errors may carry paths; keep them out of account state.
    return { status: 'error', error: READ_ERROR }
  }
}
