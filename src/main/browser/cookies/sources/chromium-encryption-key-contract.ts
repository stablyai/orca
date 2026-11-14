import type { LinuxCookieKeyFailure } from '../../../../shared/browser-workspace-types'

export type EncryptionKeyResult =
  | {
      mode: 'aes-128-cbc'
      keysByVersion: Partial<Record<'v10' | 'v11', Buffer>>
      keyringUnavailable?: boolean
      keyringFailure?: LinuxCookieKeyFailure
    }
  | { mode: 'aes-256-gcm'; key: Buffer }
