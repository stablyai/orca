import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { LinearProjectShowResult } from '../../shared/linear/project-agent-access'
import { formatLinearProjectShow } from '../../shared/linear/project-agent-format'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { formatRemoteLinearCli } from './ssh-remote-linear-output'
import { tryDispatchRemoteLinearProjectReadCli } from './ssh-remote-linear-project-read-cli'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

function createRuntime() {
  return {
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
      meta: { partial: false, includeErrors: [], sections: {} }
    })),
    linearProjectListForAgents: vi.fn(async (request: unknown) => ({
      request,
      projects: [],
      meta: {
        query: 'launch',
        workspaceId: 'workspace-1',
        limit: 5,
        returned: 0,
        hasMore: false,
        partial: false,
        workspaceErrors: []
      }
    }))
  } as unknown as OrcaRuntimeService
}

async function dispatchProjectArgv(argv: string[]) {
  const dispatch = vi.fn().mockResolvedValue({
    id: 'response-1',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-1' }
  })
  const dispatcher = { dispatch } as unknown as RpcDispatcher
  const response = await tryDispatchRemoteLinearProjectReadCli(dispatcher, parseRemoteCliArgs(argv))
  return { dispatch, response }
}

function boundedString(value: string) {
  return { value, truncated: false, chars: value.length, sha256: 'sha-value' }
}

function boundedCollection<T extends { id: string }>(items: T[]) {
  return { items, returned: items.length, total: items.length, truncated: false, sha256: 'sha-set' }
}

function projectShowResult() {
  return {
    project: {
      id: 'project-1',
      name: '\u001b[31mLaunch\u001b[0m',
      slugId: 'launch-a1b2',
      url: 'https://linear.app/acme/project/launch-a1b2',
      description: boundedString('Ship it\nfast'),
      content: { value: null, truncated: false, chars: 0, sha256: '' },
      status: { id: 'status-1', name: 'In Progress', type: 'started', color: '#000000' },
      lead: { id: 'user-1', displayName: 'Alice', avatarUrl: null },
      members: boundedCollection([{ id: 'user-1', displayName: 'Alice', avatarUrl: null }]),
      teams: boundedCollection([{ id: 'team-1', name: 'Engineering', key: 'ENG' }]),
      labels: boundedCollection<{ id: string; name: string }>([]),
      priority: 2,
      startDate: '2026-01-01',
      targetDate: null,
      color: '#112233',
      icon: null,
      health: 'onTrack',
      healthUpdatedAt: '2026-02-01T00:00:00.000Z'
    },
    meta: { workspaceId: 'workspace-1', workspaceName: 'Acme', resolvedBy: 'slug' }
  }
}

describe('SSH Linear project reads', () => {
  it('dispatches project show with the pinned RPC method and request shape', async () => {
    const { dispatch } = await dispatchProjectArgv(['linear', 'project', 'show', 'launch-a1b2'])

    expect(dispatch).toHaveBeenCalledWith({
      id: expect.stringMatching(/^remote-cli-/),
      authToken: 'remote-cli',
      method: 'linear.agentProjectShow',
      params: {
        input: 'launch-a1b2',
        workspaceId: undefined,
        updates: false
      }
    })
  })

  it('dispatches project show flag targets with the requested update feed', async () => {
    const { dispatch } = await dispatchProjectArgv([
      'linear',
      'project',
      'show',
      '--id',
      'Launch',
      '--updates',
      '--updates-limit',
      '10',
      '--workspace',
      'workspace-1',
      '--json'
    ])

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'linear.agentProjectShow',
        params: {
          input: 'Launch',
          workspaceId: 'workspace-1',
          updates: true,
          updatesLimit: 10
        }
      })
    )
  })

  it('caps --updates-limit at the shared maximum', async () => {
    const { dispatch } = await dispatchProjectArgv([
      'linear',
      'project',
      'show',
      'launch-a1b2',
      '--updates',
      '--updates-limit',
      '999'
    ])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({ updatesLimit: 25 })
  })

  it('treats --updates as a boolean without swallowing the project positional', async () => {
    const { dispatch } = await dispatchProjectArgv([
      'linear',
      'project',
      'show',
      '--updates',
      'launch-a1b2'
    ])

    expect(dispatch.mock.calls[0][0].params).toEqual({
      input: 'launch-a1b2',
      workspaceId: undefined,
      updates: true,
      updatesLimit: 5
    })
  })

  it('dispatches project statuses and labels with clamped metadata limits', async () => {
    const statuses = await dispatchProjectArgv([
      'linear',
      'project',
      'statuses',
      '--query',
      'progress',
      '--limit',
      '500',
      '--workspace',
      'all'
    ])
    const labels = await dispatchProjectArgv(['linear', 'project', 'labels'])

    expect(statuses.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'linear.agentProjectStatuses',
        params: { query: 'progress', limit: 50, workspaceId: 'all' }
      })
    )
    expect(labels.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'linear.agentProjectLabels',
        params: { query: undefined, limit: 20, workspaceId: undefined }
      })
    )
  })

  it('rejects unknown flags naming the flag and the command', async () => {
    await expect(
      dispatchProjectArgv(['linear', 'project', 'statuses', '--updates'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --updates for command: linear project statuses'
    })
  })

  it('rejects a positional project target combined with --id', async () => {
    await expect(
      dispatchProjectArgv(['linear', 'project', 'show', 'launch-a1b2', '--id', 'other'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass --id either positionally or as a flag, not both.'
    })
  })

  it('requires a project target for project show', async () => {
    await expect(dispatchProjectArgv(['linear', 'project', 'show'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass a Linear project UUID, slugId, URL, or exact name positionally or as --id'
    })
  })

  it('rejects --updates-limit without --updates', async () => {
    await expect(
      dispatchProjectArgv(['linear', 'project', 'show', 'launch-a1b2', '--updates-limit', '10'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--updates-limit requires --updates'
    })
  })

  it('rejects --workspace all for a single-project read', async () => {
    await expect(
      dispatchProjectArgv(['linear', 'project', 'show', 'launch-a1b2', '--workspace', 'all'])
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      message: '--workspace all is not valid for project show'
    })
  })

  it('ignores commands the project read shim does not own', async () => {
    const { dispatch, response } = await dispatchProjectArgv(['linear', 'project', 'list'])

    expect(response).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('SSH Linear project human output', () => {
  it('renders project show without terminal control sequences or line breaks', () => {
    const formatted = formatRemoteLinearCli(projectShowResult())

    expect(formatted?.stdout).toContain('Launch (launch-a1b2)')
    expect(formatted?.stdout).toContain('Description: 12 chars sha256 sha-value')
    expect(formatted?.stdout).toContain('Ship it fast')
    expect(formatted?.stdout).toContain('Status: In Progress (started)')
    expect(formatted?.stdout).toContain('Teams: 1 - ENG Engineering sha256 sha-set')
    expect(formatted?.stdout).toContain('Priority: high')
    // Why: SSH must render exactly what the local CLI renders; both call the one shared formatter.
    expect(formatted?.stdout.trimEnd()).toBe(
      formatLinearProjectShow(projectShowResult() as unknown as LinearProjectShowResult)
    )
    expect(formatted?.stdout).not.toContain('\u001b')
  })

  it('warns when a workspace has more project statuses than the limit returned', () => {
    const formatted = formatRemoteLinearCli({
      statuses: [
        {
          id: 'status-1',
          name: 'In Progress',
          type: 'started',
          color: '#000000',
          workspaceId: 'workspace-1',
          workspaceName: 'Acme'
        }
      ],
      meta: {
        limit: 20,
        returned: 1,
        partial: false,
        workspaceResults: [
          { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: true }
        ],
        workspaceErrors: []
      }
    })

    expect(formatted?.stdout).toContain('In Progress')
    expect(formatted?.stderr).toContain('Acme has more Linear project statuses')
  })

  it('renders grouped project labels and workspace errors', () => {
    const formatted = formatRemoteLinearCli({
      labels: [
        {
          id: 'label-1',
          name: 'Launch',
          color: '#00ff00',
          parent: { id: 'label-group', name: 'Phase' },
          workspaceId: 'workspace-1',
          workspaceName: 'Acme'
        }
      ],
      meta: {
        limit: 20,
        returned: 1,
        partial: true,
        workspaceResults: [],
        workspaceErrors: [
          {
            workspace: { id: 'workspace-2', name: 'Beta' },
            code: 'linear_not_connected',
            message: 'no token'
          }
        ]
      }
    })

    expect(formatted?.stdout).toContain('Phase/Launch')
    expect(formatted?.stderr).toContain('Beta unavailable for Linear project labels: no token')
  })

  it('keeps team labels formatting distinct from project labels', () => {
    const formatted = formatRemoteLinearCli({
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      labels: [{ id: 'label-1', name: 'Bug' }],
      meta: { workspaceId: 'workspace-1', returned: 1 }
    })

    expect(formatted?.stdout).toBe(`${'Bug'.padEnd(24)} label-1\n`)
  })
})

describe('SSH Linear parsing after adding --updates', () => {
  it('keeps repeatable and boolean parsing for existing commands', async () => {
    const listIssues = parseRemoteCliArgs([
      'linear',
      'list-issues',
      '--label',
      'Bug',
      '--label',
      'Growth',
      '--include-archived'
    ])
    const issue = parseRemoteCliArgs(['linear', 'issue', 'ENG-123', '--activity', '--full'])

    // Why: list-issues reads one --label, so the command grammar leaves it last-value-wins.
    expect(listIssues.flags.get('label')).toBe('Growth')
    expect(listIssues.flags.get('include-archived')).toBe(true)
    expect(issue.flags.get('activity')).toBe(true)
    expect(issue.commandPath).toEqual(['linear', 'issue', 'ENG-123'])
  })

  it('still dispatches existing project list reads end to end', async () => {
    const runtime = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['linear', 'project', 'list', '--query', 'launch', '--limit', '5', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { request: { query: string; limit: number } }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.request).toMatchObject({ query: 'launch', limit: 5 })
  })
})
