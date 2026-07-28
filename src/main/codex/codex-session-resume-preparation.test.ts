import { describe, expect, it, vi } from 'vitest'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'

const SESSION_ID = '019f81b9-19a9-7651-a8d1-352d9420bd11'
const ORIGIN_HOME = '/managed/origin/home'
const ORIGIN_ROLLOUT = `${ORIGIN_HOME}/sessions/2026/07/20/rollout-2026-07-20T12-00-00-${SESSION_ID}.jsonl`

// Why: these cases assert the resume/fresh outcome, never the legacy rescan's home ranking
// (#10801) — no ranking input can change a verdict here, so they stay null.
const withoutHomeRanking = {
  getSelectedAccountCodexHome: (): string | null => null,
  systemCodexHomePath: null,
  sharedRuntimeCodexHomePath: null
}

function prepare(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  resolveVerifiedResumeHome?: (source: { homePath: string }) => Promise<string>
}) {
  return prepareCodexSessionResume({
    sessionId: SESSION_ID,
    transcriptPath: args.transcriptPath,
    trustedCodexHomes: args.trustedCodexHomes,
    ...withoutHomeRanking,
    fileIsRegular: () => true,
    resolveVerifiedResumeHome: args.resolveVerifiedResumeHome ?? (async (source) => source.homePath)
  })
}

describe('prepareCodexSessionResume', () => {
  it('pins the verified origin home the caller resolved', async () => {
    const resolveVerifiedResumeHome = vi.fn(async () => '/managed/migrated/home')

    await expect(
      prepare({
        transcriptPath: ORIGIN_ROLLOUT,
        trustedCodexHomes: [ORIGIN_HOME],
        resolveVerifiedResumeHome
      })
    ).resolves.toEqual({ outcome: 'resume', codexHomePath: '/managed/migrated/home' })
    expect(resolveVerifiedResumeHome).toHaveBeenCalledWith({
      homePath: ORIGIN_HOME,
      transcriptPath: ORIGIN_ROLLOUT
    })
  })

  it('falls back to a fresh session when the rollout home is not trusted', async () => {
    // Why: returning `resume` here is exactly the #10793 bug — the pane would resume
    // under whichever account is selected now.
    const resolveVerifiedResumeHome = vi.fn(async (source: { homePath: string }) => source.homePath)

    await expect(
      prepare({
        transcriptPath: ORIGIN_ROLLOUT,
        trustedCodexHomes: ['/managed/other/home'],
        resolveVerifiedResumeHome
      })
    ).resolves.toEqual({ outcome: 'fresh', claimedCodexProvenance: true })
    // Migration, project trust and hook repair must not run without a verified home.
    expect(resolveVerifiedResumeHome).not.toHaveBeenCalled()
  })

  it('marks cross-agent metadata as never having claimed Codex provenance', async () => {
    await expect(
      prepare({
        transcriptPath: '/Users/example/.claude/projects/repo/x.jsonl',
        trustedCodexHomes: [ORIGIN_HOME]
      })
    ).resolves.toEqual({ outcome: 'fresh', claimedCodexProvenance: false })
  })

  it('marks a resume with no transcript path as unclaimed but still fresh', async () => {
    await expect(
      prepare({ transcriptPath: undefined, trustedCodexHomes: [ORIGIN_HOME] })
    ).resolves.toEqual({ outcome: 'fresh', claimedCodexProvenance: false })
  })
})

// Why: this wrapper is the only path index.ts takes to the legacy rescan, and nulling any
// ranking input here still satisfies the type-checker and every ranking test in
// codex-session-resume-home.test.ts (they call the rescan directly). Without these two the
// forwarding is unguarded, and losing it silently restores #10801's bug: a resume landing
// under an arbitrary account and staying pinned there.
describe('prepareCodexSessionResume legacy-rescan ranking forwarding', () => {
  const systemHome = '/Users/example/.codex'
  const sharedMirror = '/userData/codex-runtime-home/home'
  const accountAHome = '/userData/codex-accounts/account-a/home'
  const accountBHome = '/userData/codex-accounts/account-b/home'

  const listRolloutInEveryHome = async function* (sessionsRoot: string): AsyncIterable<string> {
    yield `${sessionsRoot}/2026/07/20/rollout-2026-07-20T15-50-19-${SESSION_ID}.jsonl`
  }

  it('resumes into the selected account home whatever order the homes arrive in', async () => {
    for (const trustedCodexHomes of [
      [systemHome, sharedMirror, accountAHome, accountBHome],
      [accountBHome, accountAHome, sharedMirror, systemHome]
    ]) {
      await expect(
        prepareCodexSessionResume({
          sessionId: SESSION_ID,
          transcriptPath: undefined,
          trustedCodexHomes,
          getSelectedAccountCodexHome: () => accountBHome,
          systemCodexHomePath: systemHome,
          sharedRuntimeCodexHomePath: sharedMirror,
          listSessionFiles: listRolloutInEveryHome,
          resolveVerifiedResumeHome: async (source) => source.homePath
        })
      ).resolves.toEqual({ outcome: 'resume', codexHomePath: accountBHome })
    }
  })

  it('keeps the selection thunk lazy on a provenance-present resume', async () => {
    // Why: the thunk stats an ownership marker, and the common resume must not pay for it.
    const getSelectedAccountCodexHome = vi.fn(() => accountBHome)

    await expect(
      prepareCodexSessionResume({
        sessionId: SESSION_ID,
        transcriptPath: ORIGIN_ROLLOUT,
        trustedCodexHomes: [ORIGIN_HOME],
        getSelectedAccountCodexHome,
        systemCodexHomePath: systemHome,
        sharedRuntimeCodexHomePath: sharedMirror,
        fileIsRegular: () => true,
        resolveVerifiedResumeHome: async (source) => source.homePath
      })
    ).resolves.toEqual({ outcome: 'resume', codexHomePath: ORIGIN_HOME })
    expect(getSelectedAccountCodexHome).not.toHaveBeenCalled()
  })
})
