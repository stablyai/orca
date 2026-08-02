import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMobileSessionHref } from './mobile-session-route'

const homeSource = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8')

describe('mobile session route', () => {
  it('keeps dynamic route identities raw for Expo Router to encode', () => {
    expect(
      createMobileSessionHref({
        hostId: 'host/one',
        worktreeId: 'repo::/Users/ada/orca/workspaces/fix #1',
        name: 'Fix #1'
      })
    ).toEqual({
      pathname: '/h/[hostId]/session/[worktreeId]',
      params: {
        hostId: 'host/one',
        worktreeId: 'repo::/Users/ada/orca/workspaces/fix #1',
        name: 'Fix #1'
      }
    })
  })

  it('routes the home Resume card through the typed dynamic href', () => {
    const start = homeSource.indexOf('{/* ─── Resume card ─── */}')
    const end = homeSource.indexOf('{/* ─── Quick actions ─── */}', start)
    const resumeCard = homeSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(resumeCard).toContain('createMobileSessionHref({')
    expect(resumeCard).not.toContain('encodeURIComponent(resumeWorktree.worktree.worktreeId)')
  })
})
