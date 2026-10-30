import type { LinuxCookieKeyFailure } from '../../../../shared/browser-workspace-types'

const CHROMIUM_EPOCH_OFFSET = 11644473600n

export function chromiumTimestampToUnix(chromiumTs: bigint | number | string): number {
  if (!chromiumTs || chromiumTs === 0n || chromiumTs === 0 || chromiumTs === '0') {
    return 0
  }
  try {
    const ts =
      typeof chromiumTs === 'bigint'
        ? chromiumTs
        : BigInt(typeof chromiumTs === 'number' ? Math.round(chromiumTs) : chromiumTs)
    if (ts === 0n) {
      return 0
    }
    return Math.max(Number(ts / 1000000n - CHROMIUM_EPOCH_OFFSET), 0)
  } catch {
    return 0
  }
}

export type EncryptionKeyResult =
  | {
      mode: 'aes-128-cbc'
      keysByVersion: Partial<Record<'v10' | 'v11', Buffer>>
      keyringUnavailable?: boolean
      keyringFailure?: LinuxCookieKeyFailure
    }
  | { mode: 'aes-256-gcm'; key: Buffer }
