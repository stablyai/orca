import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

function createRuntime() {
  const runtime = {
    getRuntimeId: () => 'runtime-test',
    getStatus: () => ({
      runtimeId: 'runtime-test',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 1,
      liveLeafCount: 1
    }),
    linearIssueContext: vi.fn(async (request: unknown) => ({
      request,
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix thing',
        url: 'https://linear.app/acme/issue/ENG-123',
        labels: []
      },
      meta: {
        requested: {
          current: true,
          include: { comments: true, children: true, attachments: true, relations: true },
          depth: 2
        },
        resolved: {
          id: 'issue-1',
          identifier: 'ENG-123',
          workspaceId: 'workspace-1',
          workspaceName: 'Acme'
        },
        partial: false,
        includeErrors: [],
        sections: {}
      }
    })),
    linearSearchForAgents: vi.fn(async (request: unknown) => ({
      request,
      issues: [],
      meta: {
        query: 'auth bug',
        limit: 5,
        returned: 0,
        limitReached: false,
        partial: false,
        workspaceErrors: []
      }
    }))
  } as unknown as OrcaRuntimeService
  return runtime
}

describe('runRemoteOrcaCli Linear commands', () => {
  it('dispatches Linear issue reads through the remote runtime with SSH context hints', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', '--current', '--full', '--json'],
      cwd: '/home/alice/remote-repo',
      env: {
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote'
      }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { current: boolean; context: Record<string, unknown> } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      current: true,
      include: { comments: true, children: true, attachments: true, relations: true },
      context: {
        remote: true,
        terminalHandle: 'term_ssh',
        worktreeId: 'repo::remote'
      }
    })
    expect(payload.result.request.context).not.toHaveProperty('cwd')
  })

  it('accepts leading boolean flags before SSH Linear commands', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['--json', 'linear', 'issue', 'ENG-123', '--full'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { input: string; include: Record<string, boolean> } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      input: 'ENG-123',
      include: { comments: true, children: true, attachments: true, relations: true }
    })
  })

  it('dispatches Linear search positional queries through the remote runtime', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'search', 'auth bug', '--limit', '5', '--workspace', 'all', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { query: string; limit: number; workspaceId: string } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toEqual({
      query: 'auth bug',
      limit: 5,
      workspaceId: 'all'
    })
  })

  it('formats SSH Linear issue reads in non-json mode', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', '--current'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ENG-123 Fix thing')
    expect(result.stdout).toContain('URL: https://linear.app/acme/issue/ENG-123')
    expect(result.stdout).not.toContain('"issue"')
  })

  it('prints SSH Linear search partial warnings to stderr in non-json mode', async () => {
    const runtime = createRuntime()
    const linearSearchForAgents = (
      runtime as unknown as { linearSearchForAgents: ReturnType<typeof vi.fn> }
    ).linearSearchForAgents
    linearSearchForAgents.mockResolvedValueOnce({
      issues: [],
      meta: {
        query: 'auth',
        limit: 20,
        returned: 0,
        limitReached: false,
        partial: true,
        workspaceErrors: [
          {
            workspace: { id: 'workspace-stale', name: 'Stale' },
            code: 'linear_network_error',
            message: 'fetch failed'
          }
        ]
      }
    })

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'search', 'auth'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('No Linear issues found.\n')
    expect(result.stderr).toContain('warning: Stale unavailable for Linear search: fetch failed')
  })

  it('formats older SSH Linear search results without workspaceErrors in non-json mode', async () => {
    const runtime = createRuntime()
    const linearSearchForAgents = (
      runtime as unknown as { linearSearchForAgents: ReturnType<typeof vi.fn> }
    ).linearSearchForAgents
    linearSearchForAgents.mockResolvedValueOnce({
      issues: [],
      meta: {
        query: 'auth',
        limit: 20,
        returned: 0,
        limitReached: false,
        partial: false
      }
    })

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'search', 'auth'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('No Linear issues found.\n')
    expect(result.stderr).toBe('')
  })

  it('prints SSH Linear non-json failures to stderr instead of stdout', async () => {
    const runtime = createRuntime()
    const linearIssueContext = (
      runtime as unknown as { linearIssueContext: ReturnType<typeof vi.fn> }
    ).linearIssueContext
    linearIssueContext.mockRejectedValueOnce(new Error('Linear is not connected.'))

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', '--current'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Linear is not connected.')
  })

  it('shows SSH Linear command help without dispatching to the runtime', async () => {
    const runtime = createRuntime()
    const linearIssueContext = (
      runtime as unknown as { linearIssueContext: ReturnType<typeof vi.fn> }
    ).linearIssueContext

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', '--help'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('orca linear issue')
    expect(result.stdout).toContain('Usage: orca linear issue')
    expect(linearIssueContext).not.toHaveBeenCalled()
  })

  it('shows SSH Linear group help without dispatching to the runtime', async () => {
    const runtime = createRuntime()
    const linearIssueContext = (
      runtime as unknown as { linearIssueContext: ReturnType<typeof vi.fn> }
    ).linearIssueContext

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', '--help'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('orca linear')
    expect(result.stdout).toContain('Usage: orca linear <command> [options]')
    expect(result.stdout).toContain('search')
    expect(linearIssueContext).not.toHaveBeenCalled()
  })

  it('shows SSH Linear help through the local help command form', async () => {
    const runtime = createRuntime()
    const linearIssueContext = (
      runtime as unknown as { linearIssueContext: ReturnType<typeof vi.fn> }
    ).linearIssueContext

    const group = await runRemoteOrcaCli(runtime, {
      argv: ['help', 'linear'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })
    const issue = await runRemoteOrcaCli(runtime, {
      argv: ['help', 'linear', 'issue'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(group.exitCode).toBe(0)
    expect(group.stdout).toContain('Usage: orca linear <command> [options]')
    expect(issue.exitCode).toBe(0)
    expect(issue.stdout).toContain('Usage: orca linear issue')
    expect(linearIssueContext).not.toHaveBeenCalled()
  })

  it('rejects ambiguous Linear issue positional and flag ids in the remote shim', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', 'ENG-123', '--id', 'ENG-456', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatchObject({
      code: 'invalid_argument',
      message: 'Pass --id either positionally or as a flag, not both.'
    })
  })

  it('rejects invalid Linear numeric flags in the remote shim', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'search', 'auth', '--limit', 'bad', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatchObject({
      code: 'invalid_argument',
      message: 'Invalid numeric value for --limit'
    })
  })

  it('preserves Linear-specific JSON error codes for pre-dispatch remote shim validation', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'issue', 'ENG-123', '--workspace', 'all', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatchObject({
      code: 'linear_invalid_workspace',
      message: '--workspace all is not valid for issue'
    })
  })
})
