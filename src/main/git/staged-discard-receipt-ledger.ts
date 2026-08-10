import path from 'node:path'
import { GitStagedDiscardReceiptFileStorage } from '../../shared/git-staged-discard-receipt-file-storage'
import { GitStagedDiscardReceiptLedger } from '../../shared/git-staged-discard-receipt-ledger'

const LEDGER_FILE_NAME = 'git-staged-discard-receipts.json'
let localLedger: GitStagedDiscardReceiptLedger | null = null

export function getLocalGitStagedDiscardReceiptLedger(): GitStagedDiscardReceiptLedger {
  if (process.env.NODE_ENV === 'test') {
    return new GitStagedDiscardReceiptLedger()
  }
  if (localLedger) {
    return localLedger
  }
  const userDataPath = process.env.ORCA_USER_DATA_PATH?.trim()
  if (!userDataPath) {
    throw new Error('Cannot initialize the staged discard replay ledger without user data')
  }
  localLedger = new GitStagedDiscardReceiptLedger({
    storage: new GitStagedDiscardReceiptFileStorage(path.join(userDataPath, LEDGER_FILE_NAME))
  })
  return localLedger
}
