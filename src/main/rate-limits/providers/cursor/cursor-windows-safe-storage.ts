import { dirname, join } from 'node:path'
import { decryptChromiumEncryptedValue } from '../../../browser/cookies/sources/browser-cookie-decryption'
import { readChromiumLocalStateDpapiKey } from '../../../windows-dpapi/chromium-local-state-key'
import { createLatestBlobDpapiUnprotect } from '../../../windows-dpapi/current-user-unprotect'

// Cursor 3.x encrypts IDE tokens at rest as this prefix + base64 safeStorage (os_crypt `v10` AES-256-GCM) output.
const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:'

type CursorIdeTokenRead =
  | { status: 'ok'; token: string }
  | { status: 'undecryptable' }
  | { status: 'error'; error: string }

// Separate from the cursor-agent cache so the two blobs don't evict each other every poll.
const unwrapLocalStateKey = createLatestBlobDpapiUnprotect()

// Local State sits in Cursor's userData, three levels above User/globalStorage/state.vscdb.
export async function decodeCursorIdeToken(
  stored: string,
  desktopStateDbPath: string
): Promise<CursorIdeTokenRead> {
  if (process.platform !== 'win32' || !stored.startsWith(SAFE_STORAGE_PREFIX)) {
    return { status: 'ok', token: stored }
  }
  const localStateKey = await readChromiumLocalStateDpapiKey(
    join(dirname(dirname(dirname(desktopStateDbPath))), 'Local State')
  )
  if (localStateKey.status !== 'ok') {
    return { status: 'undecryptable' }
  }
  let key: Buffer | null
  try {
    key = await unwrapLocalStateKey(localStateKey.wrappedKey)
  } catch {
    return { status: 'error', error: 'Unable to read the Cursor IDE encryption key' }
  }
  const plaintext =
    key &&
    decryptChromiumEncryptedValue(Buffer.from(stored.slice(SAFE_STORAGE_PREFIX.length), 'base64'), {
      mode: 'aes-256-gcm',
      key
    })
  return plaintext
    ? { status: 'ok', token: plaintext.toString('utf-8') }
    : { status: 'undecryptable' }
}
