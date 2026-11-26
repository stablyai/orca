import { describe, expect, it } from 'vitest'
import {
  codexHomeContainingFile,
  codexThreadIdFromRolloutPath,
  wslCodexDeleteTarget
} from './codex-session-delete'

const ROLLOUT =
  'sessions/2026/11/18/rollout-2026-11-18T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51.jsonl'

describe('codex delete target', () => {
  it('reads the thread id, not the rollout id, from a reverted rollout name', () => {
    const threadId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'
    expect(codexThreadIdFromRolloutPath(`/x/${ROLLOUT}`)).toBe(threadId)
    expect(
      codexThreadIdFromRolloutPath(
        `/x/sessions/2026/11/18/rollout-2026-11-18T10-00-00-${threadId}_0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52.jsonl`
      )
    ).toBe(threadId)
  })

  it('finds the home that owns a live or archived rollout and no other', () => {
    expect(codexHomeContainingFile(['/homes/a', '/homes/b'], `/homes/b/${ROLLOUT}`)).toBe(
      '/homes/b'
    )
    expect(
      codexHomeContainingFile(
        ['/homes/a'],
        '/homes/a/archived_sessions/rollout-2026-11-18T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51.jsonl'
      )
    ).toBe('/homes/a')
    expect(codexHomeContainingFile(['/homes/a'], '/elsewhere/sessions/x.jsonl')).toBeNull()
  })

  it('maps a WSL rollout into a known distro home', () => {
    const wslHomeDirs = ['\\\\wsl.localhost\\Ubuntu\\home\\me']
    expect(wslCodexDeleteTarget('Ubuntu', `/home/me/.codex/${ROLLOUT}`, wslHomeDirs)).toEqual({
      homePath: '/home/me/.codex',
      wslDistro: 'Ubuntu',
      wslHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'
    })
    expect(wslCodexDeleteTarget('Debian', `/home/me/.codex/${ROLLOUT}`, wslHomeDirs)).toBeNull()
  })
})
