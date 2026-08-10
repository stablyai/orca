import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { relayGitStagedDiscardReceiptPath } from './git-staged-discard-receipt-ledger'

describe('relay staged discard receipt storage', () => {
  it('isolates concurrent relay daemons while preserving one socket identity', () => {
    const remoteHome = path.join('remote', 'home')
    const first = relayGitStagedDiscardReceiptPath('/relay/v1/relay.sock', remoteHome)
    const replay = relayGitStagedDiscardReceiptPath('/relay/v1/relay.sock', remoteHome)
    const concurrent = relayGitStagedDiscardReceiptPath('/relay/v2/relay.sock', remoteHome)

    expect(replay).toBe(first)
    expect(concurrent).not.toBe(first)
    expect(path.dirname(first)).toBe(
      path.join(remoteHome, '.orca-relay', 'git-staged-discard-receipts')
    )
  })

  it('does not embed a Windows named-pipe path in the file name', () => {
    const receiptPath = relayGitStagedDiscardReceiptPath(
      String.raw`\\.\pipe\orca-relay-v1`,
      String.raw`C:\Users\orca`
    )

    expect(path.basename(receiptPath)).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(receiptPath).not.toContain('pipe')
  })
})
