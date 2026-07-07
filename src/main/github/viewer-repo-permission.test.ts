import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhUtils from './gh-utils'

const { ghExecFileAsyncMock, resolveIssueSourceMock, acquireMock, releaseMock } = vi.hoisted(
  () => ({
    ghExecFileAsyncMock: vi.fn(),
    resolveIssueSourceMock: vi.fn(),
    acquireMock: vi.fn(),
    releaseMock: vi.fn()
  })
)

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { getViewerRepoPermission } from './viewer-repo-permission'

describe('getViewerRepoPermission', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    resolveIssueSourceMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    resolveIssueSourceMock.mockResolvedValue({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })

  function mockPermissions(flags: Record<string, boolean>): void {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify({ permissions: flags }) })
  }

  // Why: the flags are cumulative on GitHub (admin implies push etc.) — the
  // mapping must pick the highest tier, and read-only repos (pull only) must
  // land on 'read' so the dialog gates its mutation affordances.
  it.each([
    [{ admin: true, maintain: true, push: true, triage: true, pull: true }, 'admin'],
    [{ maintain: true, push: true, triage: true, pull: true }, 'maintain'],
    [{ push: true, triage: true, pull: true }, 'write'],
    [{ triage: true, pull: true }, 'triage'],
    [{ pull: true }, 'read']
  ] as const)('maps %j to %s', async (flags, expected) => {
    mockPermissions(flags as Record<string, boolean>)

    const result = await getViewerRepoPermission('/repo', 'auto')

    expect(result).toEqual({ permission: expected, source: { owner: 'stablyai', repo: 'orca' } })
  })

  it('targets the override slug instead of the resolved source when given', async () => {
    mockPermissions({ admin: true })

    const result = await getViewerRepoPermission(
      '/repo',
      'auto',
      null,
      {},
      {
        owner: 'tebayoso',
        repo: 'orca'
      }
    )

    expect(resolveIssueSourceMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain('repos/tebayoso/orca')
    expect(result?.source).toEqual({ owner: 'tebayoso', repo: 'orca' })
  })

  // Why: callers fail open on null — a transient gh failure must not lock
  // users out of controls on repos they can actually write to.
  it('returns null when the gh call fails', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('boom'))

    expect(await getViewerRepoPermission('/repo', 'auto')).toBeNull()
  })

  it('rejects slugs that could smuggle path segments', async () => {
    expect(
      await getViewerRepoPermission('/repo', 'auto', null, {}, { owner: 'a/b', repo: 'c' })
    ).toBeNull()
    expect(
      await getViewerRepoPermission('/repo', 'auto', null, {}, { owner: '..', repo: 'orca' })
    ).toBeNull()
    expect(
      await getViewerRepoPermission('/repo', 'auto', null, {}, { owner: 'stablyai', repo: '.' })
    ).toBeNull()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  // Why: `permissions` is absent in some auth contexts (app tokens). That's
  // an unknown — mapping it to 'read' would hide write controls, so it must
  // behave like a failed probe (null, callers fail open).
  it('returns null when the payload has no permissions object', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify({ full_name: 'x/y' }) })

    expect(await getViewerRepoPermission('/repo', 'auto')).toBeNull()
  })
})
