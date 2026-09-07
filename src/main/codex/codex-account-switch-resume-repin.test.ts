import { describe, expect, it, vi } from 'vitest'
import { resolveCodexAccountSwitchResumeHome } from './codex-account-switch-resume-repin'

const ORIGIN = '/data/codex-accounts/account-a/home'
const SELECTED = '/data/codex-accounts/account-b/home'
const TRANSCRIPT = `${ORIGIN}/sessions/2026/08/16/rollout-2026-08-16T00-00-00-abc.jsonl`

describe('resolveCodexAccountSwitchResumeHome', () => {
  it('moves the resume onto the selected account once its rollout is listed there', () => {
    const linkRollout = vi.fn(() => `${SELECTED}/sessions/2026/08/16/rollout-x.jsonl`)

    expect(
      resolveCodexAccountSwitchResumeHome({
        originCodexHomePath: ORIGIN,
        selectedCodexHomePath: SELECTED,
        transcriptPath: TRANSCRIPT,
        linkRollout
      })
    ).toEqual({ outcome: 'moved', codexHomePath: SELECTED })
    expect(linkRollout).toHaveBeenCalledWith({
      sourceCodexHomePath: ORIGIN,
      targetCodexHomePath: SELECTED,
      rolloutFilePath: TRANSCRIPT
    })
  })

  it('reports a pane already on the selected account as nothing to move', () => {
    const linkRollout = vi.fn(() => `${ORIGIN}/sessions/x.jsonl`)

    expect(
      resolveCodexAccountSwitchResumeHome({
        originCodexHomePath: ORIGIN,
        selectedCodexHomePath: `${ORIGIN}/`,
        transcriptPath: TRANSCRIPT,
        linkRollout
      })
    ).toEqual({ outcome: 'already-there' })
    // Why asserted: treating this as a give-up would discard a conversation that
    // was never at risk, since the pane's own account is the selected one.
    expect(linkRollout).not.toHaveBeenCalled()
  })

  it('reports the system default as unmovable without attempting a link', () => {
    const linkRollout = vi.fn(() => `${SELECTED}/sessions/x.jsonl`)

    expect(
      resolveCodexAccountSwitchResumeHome({
        originCodexHomePath: ORIGIN,
        selectedCodexHomePath: null,
        transcriptPath: TRANSCRIPT,
        linkRollout
      })
    ).toEqual({ outcome: 'unmovable' })
    expect(linkRollout).not.toHaveBeenCalled()
  })

  it('reports a refused link as unmovable rather than resuming on the old account', () => {
    expect(
      resolveCodexAccountSwitchResumeHome({
        originCodexHomePath: ORIGIN,
        selectedCodexHomePath: SELECTED,
        transcriptPath: TRANSCRIPT,
        linkRollout: vi.fn(() => null)
      })
    ).toEqual({ outcome: 'unmovable' })
  })

  it('reports a thrown link as unmovable', () => {
    expect(
      resolveCodexAccountSwitchResumeHome({
        originCodexHomePath: ORIGIN,
        selectedCodexHomePath: SELECTED,
        transcriptPath: TRANSCRIPT,
        linkRollout: vi.fn(() => {
          throw new Error('EPERM')
        })
      })
    ).toEqual({ outcome: 'unmovable' })
  })
})
