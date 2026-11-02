import { describe, expect, it } from 'vitest'
import { formatAutomaticWorkResume } from './serve-restore'

const refusedAt = Date.UTC(2026, 9, 11, 12, 0, 0)

describe('formatAutomaticWorkResume', () => {
  it('lists the old-client restores the host kept, with the command that resumes each', () => {
    const output = formatAutomaticWorkResume({
      automaticWork: {
        admission: 'enforce',
        mode: { kind: 'normal' },
        cleared: null,
        legacyRestores: [
          {
            sessionId: 'wt@@1',
            reason: 'pressure',
            refusedAt,
            agent: 'claude',
            cwd: '/repo',
            worktreeId: 'wt',
            command: 'claude --resume 6f1c',
            identityDigest: null
          },
          {
            sessionId: 'wt@@2',
            reason: 'host_cap',
            refusedAt,
            agent: null,
            cwd: null,
            worktreeId: null,
            command: null,
            identityDigest: null
          }
        ]
      }
    })
    expect(output).toBe(
      [
        'Automatic restores were not paused; nothing to resume.',
        '',
        'This host refused 2 restores from an older Orca client and kept them here:',
        '- claude in /repo, refused 2026-10-11T12:00:00.000Z (the host was under heavy process load). Resume it with: claude --resume 6f1c',
        '- an agent, refused 2026-10-11T12:00:00.000Z (the host had reached its terminal limit). Its resume command was not recorded.'
      ].join('\n')
    )
  })

  it('prints nothing extra when no restore was kept, or the host predates the record', () => {
    expect(
      formatAutomaticWorkResume({
        automaticWork: { admission: 'enforce', mode: { kind: 'normal' }, cleared: null }
      })
    ).toBe('Automatic restores were not paused; nothing to resume.')
  })
})
