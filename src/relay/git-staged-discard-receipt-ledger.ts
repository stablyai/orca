import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { GitStagedDiscardReceiptFileStorage } from '../shared/git-staged-discard-receipt-file-storage'
import { GitStagedDiscardReceiptLedger } from '../shared/git-staged-discard-receipt-ledger'

export function createRelayGitStagedDiscardReceiptLedger(
  relaySocketPath: string
): GitStagedDiscardReceiptLedger {
  return new GitStagedDiscardReceiptLedger({
    storage: new GitStagedDiscardReceiptFileStorage(
      relayGitStagedDiscardReceiptPath(relaySocketPath)
    )
  })
}

export function relayGitStagedDiscardReceiptPath(
  relaySocketPath: string,
  remoteHome = homedir()
): string {
  const relayIdentity = createHash('sha256').update(relaySocketPath).digest('hex')
  return path.join(
    remoteHome,
    '.orca-relay',
    'git-staged-discard-receipts',
    `${relayIdentity}.json`
  )
}
