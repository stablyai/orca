import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

export const INCOGNITO_PASSCODE_MIN_LENGTH = 4

const KEY_LENGTH = 64
// Why: N=2^15 keeps a verify near ~50ms on laptops while making offline guessing costly.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

type PasscodeRecord = {
  version: 1
  salt: string
  hash: string
}

function deriveKey(passcode: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  })
}

function parseRecord(raw: string): PasscodeRecord | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value === 'object' &&
      value !== null &&
      'version' in value &&
      value.version === 1 &&
      'salt' in value &&
      typeof value.salt === 'string' &&
      'hash' in value &&
      typeof value.hash === 'string'
    ) {
      return { version: 1, salt: value.salt, hash: value.hash }
    }
  } catch {
    // A corrupt file reads as "no passcode", so the user can set a new one.
  }
  return null
}

/** Stores only a salted scrypt hash of the incognito passcode; the passcode itself never touches disk. */
export class IncognitoPasscodeStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<PasscodeRecord | null> {
    try {
      return parseRecord(await readFile(this.filePath, 'utf-8'))
    } catch {
      return null
    }
  }

  async hasPasscode(): Promise<boolean> {
    return (await this.read()) !== null
  }

  async setPasscode(passcode: string): Promise<void> {
    if (passcode.length < INCOGNITO_PASSCODE_MIN_LENGTH) {
      throw new Error('Passcode is too short')
    }
    const salt = randomBytes(16)
    const hash = await deriveKey(passcode, salt)
    const record: PasscodeRecord = {
      version: 1,
      salt: salt.toString('base64'),
      hash: hash.toString('base64')
    }
    writeFileAtomically(this.filePath, JSON.stringify(record), { mode: 0o600 })
  }

  async verify(passcode: string): Promise<boolean> {
    const record = await this.read()
    if (!record) {
      return false
    }
    const expected = Buffer.from(record.hash, 'base64')
    const actual = await deriveKey(passcode, Buffer.from(record.salt, 'base64'))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}
