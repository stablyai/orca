import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAmbiguousIdOnlyAccountResume } from './codex-session-resume-ambiguous-id'

const THREAD = '00000000-0000-4000-8000-0000000000aa'
const rollout = (home: string) =>
  `${home}/sessions/2026/11/24/rollout-2026-11-24T00-00-00-${THREAD}.jsonl`

function check(holders: string[], transcriptPath?: string) {
  return isAmbiguousIdOnlyAccountResume({
    sessionId: THREAD,
    transcriptPath,
    trustedCodexHomes: ['/system', '/shared', '/accounts/a', '/accounts/b'],
    getSelectedAccountCodexHome: () => '/accounts/b',
    systemCodexHomePath: '/system',
    sharedRuntimeCodexHomePath: '/shared',
    listSessionFiles: async function* (sessionsRoot: string) {
      const home = sessionsRoot.replace(/\/sessions$/, '')
      if (holders.includes(home)) {
        yield rollout(home)
      }
    }
  })
}

describe('ID-only Codex resume across accounts', () => {
  it('is ambiguous when the selected copy would win over another account holding the thread', async () => {
    await expect(check(['/accounts/a', '/accounts/b'])).resolves.toBe(true)
  })

  it('stays resumable for a migration copy in the system or shared legacy home', async () => {
    await expect(check(['/shared', '/accounts/b'])).resolves.toBe(false)
    await expect(check(['/system', '/accounts/b'])).resolves.toBe(false)
  })

  it('stays resumable when only one account holds it or the transcript path names it', async () => {
    await expect(check(['/accounts/b'])).resolves.toBe(false)
    await expect(check(['/accounts/a', '/accounts/b'], rollout('/accounts/a'))).resolves.toBe(false)
  })

  it('treats account homes linked to one sessions store as one copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-linked-history-'))
    try {
      const shared = join(root, 'store')
      mkdirSync(shared)
      for (const account of ['a', 'b']) {
        mkdirSync(join(root, account))
        symlinkSync(shared, join(root, account, 'sessions'))
      }
      const ambiguous = await isAmbiguousIdOnlyAccountResume({
        sessionId: THREAD,
        transcriptPath: undefined,
        trustedCodexHomes: [join(root, 'a'), join(root, 'b')],
        getSelectedAccountCodexHome: () => join(root, 'b'),
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null,
        listSessionFiles: async function* (sessionsRoot: string) {
          yield `${sessionsRoot}/2026/11/24/rollout-2026-11-24T00-00-00-${THREAD}.jsonl`
        }
      })
      expect(ambiguous).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a competing account home it could not read as unproven', async () => {
    const ambiguous = await isAmbiguousIdOnlyAccountResume({
      sessionId: THREAD,
      transcriptPath: undefined,
      trustedCodexHomes: ['/accounts/a', '/accounts/b'],
      getSelectedAccountCodexHome: () => '/accounts/b',
      systemCodexHomePath: null,
      sharedRuntimeCodexHomePath: null,
      listSessionFiles: async function* (sessionsRoot: string, onDirectoryError) {
        if (sessionsRoot.startsWith('/accounts/b')) {
          yield rollout('/accounts/b')
          return
        }
        onDirectoryError(Object.assign(new Error('denied'), { code: 'EACCES' }))
      }
    })
    expect(ambiguous).toBe(true)
  })
})
