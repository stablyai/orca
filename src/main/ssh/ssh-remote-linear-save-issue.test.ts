import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

function createRuntime() {
  const linearSaveIssue = vi.fn(async (request: unknown) => ({
    request,
    issue: {
      id: 'issue-1',
      identifier: 'ENG-123',
      title: 'Updated title',
      url: 'https://linear.app/acme/issue/ENG-123',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      state: { id: 'state-1', name: 'Todo' },
      parent: null
    },
    meta: { workspaceId: 'workspace-1', created: false }
  }))
  return {
    runtime: {
      getRuntimeId: () => 'runtime-test',
      linearSaveIssue
    } as unknown as OrcaRuntimeService,
    linearSaveIssue
  }
}

describe('SSH remote Linear save issue', () => {
  it('forwards update fields, clears, stdin, and SSH context without losing types', async () => {
    const { runtime, linearSaveIssue } = createRuntime()
    const result = await runRemoteOrcaCli(runtime, {
      argv: [
        'linear',
        'save-issue',
        'ENG-123',
        '--body-file',
        '-',
        '--assignee',
        'null',
        '--estimate',
        'null',
        '--due-date',
        'null',
        '--label',
        'Bug',
        '--label',
        'Regression',
        '--json'
      ],
      cwd: '/home/alice/remote-repo',
      env: {
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote'
      },
      stdin: 'Updated description'
    })

    expect(result.exitCode).toBe(0)
    expect(linearSaveIssue).toHaveBeenCalledWith({
      input: 'ENG-123',
      current: false,
      workspaceId: undefined,
      context: {
        remote: true,
        terminalHandle: 'term_ssh',
        worktreeId: 'repo::remote'
      },
      team: undefined,
      title: undefined,
      description: 'Updated description',
      state: undefined,
      assignee: null,
      priority: undefined,
      estimate: null,
      dueDate: null,
      labels: ['Bug', 'Regression'],
      project: undefined,
      parentId: undefined,
      writeId: undefined
    })
  })

  it('forwards the team and title required for create mode', async () => {
    const { runtime, linearSaveIssue } = createRuntime()
    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'save-issue', '--team', 'ENG', '--title', 'New issue', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(linearSaveIssue).toHaveBeenCalledWith(
      expect.objectContaining({ input: undefined, current: false, team: 'ENG', title: 'New issue' })
    )
  })

  it('rejects remote body paths instead of reading from the wrong filesystem', async () => {
    const { runtime, linearSaveIssue } = createRuntime()
    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'save-issue', 'ENG-123', '--body-file', 'body.md', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(1)
    expect(linearSaveIssue).not.toHaveBeenCalled()
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
  })
})
