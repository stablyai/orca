import { readKeptCopies, writeKeptCopies } from './codex-account-copies-kept'
import { moveCheckedCopiesToTrash } from './codex-account-copies-trash'
import { deleteTrashedCopies, recheckTrashedCopies } from './codex-account-copies-trash-recheck'
import type { VerifiedCopy } from './codex-account-copy-checks'
import { removeEmptiedCopyFolders } from './codex-account-copy-roots'
import {
  ACL_KEEP,
  assertOwnedHome,
  homeName,
  verifyCodexAccountCopies
} from './codex-account-copies'
import type {
  CodexAccountCopiesRequest,
  CodexAccountCopiesResponse
} from './codex-account-copies-worker-protocol'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

/** Notes copies kept for an ACL, keyed to both files as compared, so later launches skip them. */
function rememberAclKeeps(accountHome: string, copies: VerifiedCopy[]): void {
  const record = readKeptCopies(accountHome)
  for (const copy of copies) {
    const name = homeName(accountHome, copy.copy)
    record.differs[name] = `${ACL_KEEP}${copy.copyKey}|${copy.original}|${copy.originalKey}`
  }
  writeKeptCopies(accountHome, { ...record, settled: null })
}

export async function runCodexAccountCopiesRequest(
  request: CodexAccountCopiesRequest
): Promise<CodexAccountCopiesResponse> {
  switch (request.op) {
    case 'verify':
      return { ok: true, op: 'verify', ...(await verifyCodexAccountCopies(request)) }
    case 'trash':
      return {
        ok: true,
        op: 'trash',
        tally: moveCheckedCopiesToTrash(request.accountHome, request.copies, request.lockFolders)
      }
    case 'recheck-trash':
      assertOwnedHome(request)
      return { ok: true, op: 'recheck-trash', ...recheckTrashedCopies(request) }
    case 'delete-trashed':
      return {
        ok: true,
        op: 'delete-trashed',
        tally: deleteTrashedCopies(request.accountHome, request.copies)
      }
    case 'remember-acl':
      rememberAclKeeps(request.accountHome, request.copies)
      return { ok: true, op: 'remember-acl' }
    case 'prune':
      removeEmptiedCopyFolders(request.accountHome, request.storeHome)
      return { ok: true, op: 'prune' }
  }
}
