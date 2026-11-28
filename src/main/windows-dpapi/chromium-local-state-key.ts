import { readFile } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'

const DPAPI_KEY_PREFIX = Buffer.from('DPAPI', 'utf-8')

export type ChromiumLocalStateKeyRead =
  | { status: 'ok'; wrappedKey: string }
  | { status: 'absent' }
  | { status: 'unreadable' }

/** `unreadable` (file present but unreadable or malformed) is split from `absent` so cookie import can log it. */
export async function readChromiumLocalStateDpapiKey(
  localStatePath: string
): Promise<ChromiumLocalStateKeyRead> {
  let encryptedKey: unknown
  try {
    encryptedKey = JSON.parse(await readFile(localStatePath, 'utf-8'))?.os_crypt?.encrypted_key
  } catch (err) {
    return isDefinitiveAbsence(err) ? { status: 'absent' } : { status: 'unreadable' }
  }
  if (typeof encryptedKey !== 'string') {
    return { status: 'absent' }
  }
  const wrapped = Buffer.from(encryptedKey, 'base64')
  if (
    wrapped.length <= DPAPI_KEY_PREFIX.length ||
    !wrapped.subarray(0, DPAPI_KEY_PREFIX.length).equals(DPAPI_KEY_PREFIX)
  ) {
    return { status: 'absent' }
  }
  return { status: 'ok', wrappedKey: wrapped.subarray(DPAPI_KEY_PREFIX.length).toString('base64') }
}
