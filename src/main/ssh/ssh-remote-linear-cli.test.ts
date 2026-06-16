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
        labels: [{ id: 'label-1', name: 'Bug' }],
        priority: 2,
        estimate: 5,
        dueDate: '2026-06-30'
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
    })),
    linearTeamListForAgents: vi.fn(async (request: unknown) => ({
      request,
      teams: [
        {
          id: 'team-1',
          key: 'ENG',
          name: 'Engineering',
          workspace: { id: 'workspace-1', name: 'Acme' }
        }
      ],
      meta: { workspaceId: 'workspace-1', returned: 1, partial: false, workspaceErrors: [] }
    })),
    linearTeamLabelsForAgents: vi.fn(async (request: unknown) => ({
      request,
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      labels: [{ id: 'label-1', name: 'Bug', color: '#ff0000' }],
      meta: { workspaceId: 'workspace-1', returned: 1 }
    })),
    linearIssueListForAgents: vi.fn(async (request: unknown) => ({
      request,
      issues: [],
      meta: {
        filter: 'open',
        workspaceId: 'workspace-1',
        limit: 5,
        returned: 0,
        hasMore: false,
        partial: false,
        workspaceErrors: []
      }
    })),
    linearIssueSetState: vi.fn(async (request: unknown) => ({
      request,
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        url: 'https://linear.app/acme/issue/ENG-123'
      },
      state: { id: 'state-review', name: 'In Review', type: 'started' },
      previousState: { id: 'state-started', name: 'In Progress' },
      meta: { workspaceId: 'workspace-1', alreadyInState: false }
    })),
    linearIssueUpdateTask: vi.fn(async (request: unknown) => ({
      request,
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        url: 'https://linear.app/acme/issue/ENG-123'
      },
      operation: 'priority',
      previous: {
        assignee: null,
        priority: 0,
        estimate: null,
        dueDate: null,
        labels: []
      },
      current: {
        assignee: null,
        priority: 2,
        estimate: null,
        dueDate: null,
        labels: []
      },
      meta: { workspaceId: 'workspace-1', alreadySet: false }
    })),
    linearIssueAddComment: vi.fn(async (request: unknown) => ({
      request,
      comment: { id: 'comment-1', url: null, parentId: null },
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        url: 'https://linear.app/acme/issue/ENG-123'
      },
      meta: {
        workspaceId: 'workspace-1',
        bodyChars: 4,
        writeId: '123e4567-e89b-12d3-a456-426614174000',
        deduplicated: false
      }
    })),
    linearIssueAttachLink: vi.fn(async (request: unknown) => ({
      request,
      attachment: { id: 'attachment-1', title: 'PR/MR link', url: 'https://example.com/review/1' },
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        url: 'https://linear.app/acme/issue/ENG-123'
      },
      meta: {
        workspaceId: 'workspace-1',
        writeId: '123e4567-e89b-12d3-a456-426614174000',
        deduplicated: false
      }
    })),
    linearIssueCreate: vi.fn(async (request: unknown) => ({
      request,
      issue: {
        id: 'issue-2',
        identifier: 'ENG-456',
        title: 'Follow-up',
        url: 'https://linear.app/acme/issue/ENG-456',
        team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
        state: { id: 'state-triage', name: 'Triage' },
        parent: { id: 'issue-1', identifier: 'ENG-123' }
      },
      meta: {
        workspaceId: 'workspace-1',
        writeId: '123e4567-e89b-12d3-a456-426614174000',
        deduplicated: false
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

  it('dispatches Linear discovery and list reads through the remote runtime', async () => {
    const runtime = createRuntime()

    const teamList = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'team', 'list', '--workspace', 'all', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })
    const labels = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'team', 'labels', '--team', 'ENG', '--workspace', 'workspace-1', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })
    const list = await runRemoteOrcaCli(runtime, {
      argv: [
        'linear',
        'list',
        '--filter',
        'open',
        '--team',
        'ENG',
        '--limit',
        '5',
        '--workspace',
        'workspace-1',
        '--json'
      ],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(teamList.exitCode).toBe(0)
    expect(labels.exitCode).toBe(0)
    expect(list.exitCode).toBe(0)
    expect(
      (runtime as unknown as { linearTeamListForAgents: ReturnType<typeof vi.fn> })
        .linearTeamListForAgents
    ).toHaveBeenCalledWith({ workspaceId: 'all' })
    expect(
      (runtime as unknown as { linearTeamLabelsForAgents: ReturnType<typeof vi.fn> })
        .linearTeamLabelsForAgents
    ).toHaveBeenCalledWith({ teamInput: 'ENG', workspaceId: 'workspace-1' })
    expect(
      (runtime as unknown as { linearIssueListForAgents: ReturnType<typeof vi.fn> })
        .linearIssueListForAgents
    ).toHaveBeenCalledWith({
      filter: 'open',
      teamInput: 'ENG',
      limit: 5,
      workspaceId: 'workspace-1'
    })
  })

  it('dispatches Linear status writes through the remote runtime with SSH context hints', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'status', 'set', 'ENG-123', '--to', 'In Review', '--json'],
      cwd: '/home/alice/remote-repo',
      env: {
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote'
      }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { input: string; to: string; context: Record<string, unknown> } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      input: 'ENG-123',
      to: 'In Review',
      context: {
        remote: true,
        terminalHandle: 'term_ssh',
        worktreeId: 'repo::remote'
      }
    })
  })

  it('dispatches Linear task-field writes through the SSH remote runtime', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'priority', 'set', 'ENG-123', '--to', 'high', '--json'],
      cwd: '/home/alice/remote-repo',
      env: {
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote'
      }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { input: string; operation: string; priority: number } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      input: 'ENG-123',
      operation: 'priority',
      priority: 2
    })
  })

  it('parses --me as a boolean for SSH Linear assignee writes', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'assignee', 'set', '--me', 'ENG-123', '--json'],
      cwd: '/home/alice/remote-repo',
      env: {
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote'
      }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { input: string; operation: string; assigneeMe: boolean } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      input: 'ENG-123',
      operation: 'assignee',
      assigneeMe: true
    })
  })

  it('preserves repeated labels for SSH Linear label writes', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: [
        'linear',
        'label',
        'set',
        'ENG-123',
        '--label',
        'label-1',
        '--label',
        'label-2',
        '--json'
      ],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { operation: string; labelMode: string; labels: string[] } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({
      operation: 'labels',
      labelMode: 'set',
      labels: ['label-1', 'label-2']
    })
  })

  it('formats SSH Linear writes in non-json mode', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'comment', 'add', 'ENG-123', '--body', 'Done'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('Added comment comment-1 to ENG-123.\n')
    expect(result.stderr).toBe('')
  })

  it('dispatches body-file stdin writes in the SSH shim', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'comment', 'add', '--current', '--body-file', '-', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' },
      stdin: 'line one\nline two\n'
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { body: string } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request.body).toBe('line one\nline two\n')
  })

  it('rejects body-file stdin writes when SSH stdin is unavailable', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'comment', 'add', '--current', '--body-file', '-', '--json'],
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
      message: 'SSH Linear writes require stdin when using --body-file -.'
    })
  })

  it('rejects remote body-file paths in the SSH shim before dispatch', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'comment', 'add', '--current', '--body-file', 'body.md', '--json'],
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
      message: 'SSH Linear writes only support --body-file - for stdin.'
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
    expect(result.stdout).toContain('Priority: high')
    expect(result.stdout).toContain('Estimate: 5')
    expect(result.stdout).toContain('Labels: Bug')
    expect(result.stdout).toContain('Due: 2026-06-30')
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

  it('prints SSH Linear non-json next steps from structured errors', async () => {
    const runtime = createRuntime()
    const linearIssueAddComment = (
      runtime as unknown as { linearIssueAddComment: ReturnType<typeof vi.fn> }
    ).linearIssueAddComment
    linearIssueAddComment.mockRejectedValueOnce(
      Object.assign(new Error('Linear may have applied the write.'), {
        code: 'linear_write_unconfirmed',
        data: { nextSteps: ['Retry once with the pinned command: `orca linear comment add`.'] }
      })
    )

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'comment', 'add', 'ENG-123', '--body', 'Done'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Linear may have applied the write.')
    expect(result.stderr).toContain('Next step: Retry once with the pinned command')
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
    expect(result.stdout).toContain('team list')
    expect(result.stdout).toContain('label set')
    expect(result.stdout).toContain('comment add')
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
