import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'

export type EncryptedFileRecord = { nonceHex: string; ciphertextHex: string }
export type EncryptedFileV1 = {
  version: 1
  saltHex: string
  records: Record<string, EncryptedFileRecord>
}

export function recordKey(service: string, account: string): string {
  // Why: "::" is the separator; escape any literal "::" inside service/account
  // so the key remains unambiguous (URL-encoded form is reversible and safe).
  const safe = (value: string): string => value.replace(/::/g, '%3A%3A')
  return `${safe(service)}::${safe(account)}`
}

export async function readEncryptedFile(path: string): Promise<EncryptedFileV1 | null> {
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  const parsed = JSON.parse(raw) as { version?: number }
  if (parsed.version !== 1) {
    throw new Error(`Unsupported encrypted secrets file version: ${parsed.version}`)
  }
  return parsed as EncryptedFileV1
}

export async function writeEncryptedFile(path: string, file: EncryptedFileV1): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, path)
  if (process.platform !== 'win32') {
    // Why: rename preserves tmp mode but be explicit for systems where umask
    // overrode the writeFile mode.
    await fsp.chmod(path, 0o600)
  }
}
