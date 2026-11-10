import { describe, expect, it, vi } from 'vitest'

// The attach flow pulls in pairing and transport; the copy only needs its error class.
vi.mock('./cloud-workspace-attach', () => ({
  CloudAttachError: class CloudAttachError extends Error {
    constructor(readonly code: string) {
      super(code)
      this.name = 'CloudAttachError'
    }
  }
}))

import type { Translate } from '../i18n/mobile-i18n'
import { CloudRequestError } from './cloud-control-plane-request'
import { CloudAttachError } from './cloud-workspace-attach'
import { attachErrorMessage, readSnapshotRefusedMessage } from './cloud-workspace-copy'

const t: Translate = (_key, fallback) => fallback

describe('cloud workspace copy', () => {
  it('says a failed wake plainly, and keeps the generic line for anything else', () => {
    expect(attachErrorMessage(new CloudAttachError('wake_failed'), t)).toBe(
      'Couldn’t wake the sandbox. Your files are safe.'
    )
    expect(attachErrorMessage(new CloudRequestError('http_error', 503), t)).toBe(
      'Something went wrong. Your files are safe.'
    )
  })

  it('names why a read-only copy is refused', () => {
    expect(readSnapshotRefusedMessage('rollback', t)).toBe(
      'Orca Cloud sent an older copy than the one you last saw, so it isn’t shown. Wake the workspace to see it as it is now.'
    )
    const unsigned =
      'The saved copy of this workspace couldn’t be verified, so it isn’t shown. Wake the workspace to see it as it is now.'
    expect(readSnapshotRefusedMessage('signer_changed', t)).toBe(
      'The saved copy of this workspace is signed by a different key than before, so it isn’t shown. Wake the workspace to see it as it is now.'
    )
    expect(readSnapshotRefusedMessage('unsigned', t)).toBe(unsigned)
    expect(readSnapshotRefusedMessage('bad_signature', t)).toBe(unsigned)
  })
})
