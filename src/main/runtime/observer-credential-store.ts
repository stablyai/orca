import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decodeObserverLedger,
  isObserverCredentialTokenShape,
  matchObserverCredential,
  MAX_OBSERVER_LEDGER_BYTES,
  OBSERVER_LEDGER_NAME,
  type ObserverCredential
} from './observer-credential-ledger'

export class ObserverCredentialStore {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OBSERVER_LEDGER_NAME)
  }

  async authenticate(token: string): Promise<ObserverCredential | null> {
    if (!isObserverCredentialTokenShape(token)) {
      return null
    }
    try {
      const flags =
        process.platform === 'win32'
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      const file = await open(this.path, flags)
      try {
        const metadata = await file.stat()
        if (
          !metadata.isFile() ||
          metadata.size <= 0 ||
          metadata.size > MAX_OBSERVER_LEDGER_BYTES ||
          (process.platform !== 'win32' &&
            ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))
        ) {
          return null
        }
        const buffer = Buffer.alloc(metadata.size + 1)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
          if (bytesRead === 0) {
            break
          }
          offset += bytesRead
        }
        if (offset !== metadata.size) {
          return null
        }
        return matchObserverCredential(
          decodeObserverLedger(buffer.toString('utf8', 0, offset)),
          token
        )
      } finally {
        await file.close()
      }
    } catch {
      return null
    }
  }
}
