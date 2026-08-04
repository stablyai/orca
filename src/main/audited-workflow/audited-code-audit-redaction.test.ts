// P3. CODE-AUDIT SUMMARY LEAKAGE.
//
// codeAuditSummary is the one free-text field this lane projects. It is
// model-authored, and Codex runs with the audited worktree as its working root
// and can read the repository — so its summary can quote an absolute path or the
// audited branch name verbatim.
//
// The summary is redacted BEFORE storage, because every later consumer (the
// projection, the IPC result, the renderer prop) reads the stored value.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { sanitizeReviewSummary } from './audited-plan-artifact-store'

// The identity values a real deployment would have. Chosen so a naive
// implementation leaks them.
const WORKTREE_PATH = 'C:\\Users\\alice\\orca\\worktrees\\audited-task-1'
const SOURCE_REPO = 'C:\\Users\\alice\\orca'
const COMMON_DIR = 'C:\\Users\\alice\\orca\\.git'
const BRANCH = 'audited/task-1-secret-feature'

const CONTEXT = {
  worktreePath: WORKTREE_PATH,
  sourceRepoPath: SOURCE_REPO,
  sourceRepoCommonDir: COMMON_DIR,
  branchName: BRANCH,
  userDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\Orca',
  homePath: 'C:\\Users\\alice'
}

const LEAKY = [
  `The change edits ${WORKTREE_PATH}\\src\\index.ts`,
  `and also C:/Users/alice/orca/worktrees/audited-task-1/src/other.ts.`,
  `It targets branch ${BRANCH} in ${SOURCE_REPO}.`,
  `Git metadata lives at ${COMMON_DIR}.`
].join(' ')

const LEAKY_SUBSTRINGS = ['alice', WORKTREE_PATH, SOURCE_REPO, COMMON_DIR, BRANCH, 'C:/Users/alice']

describe('code-audit summary redaction', () => {
  it('removes every identity value the audit could have observed', () => {
    const sanitized = sanitizeReviewSummary(LEAKY, CONTEXT)

    for (const leak of LEAKY_SUBSTRINGS) {
      expect(sanitized, `sanitized summary must not contain "${leak}"`).not.toContain(leak)
    }
  })

  it('redacts a credential the model echoed into its summary', () => {
    const sanitized = sanitizeReviewSummary(
      'The code hardcodes sk-abcdefghijklmnopqrstuvwxyz012345.',
      CONTEXT
    )
    expect(sanitized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('keeps the reviewer’s actual reasoning readable', () => {
    const sanitized = sanitizeReviewSummary(
      'The retry loop never resets its counter, so it spins forever.',
      CONTEXT
    )
    expect(sanitized).toContain('retry loop')
    expect(sanitized).toContain('spins forever')
  })
})
