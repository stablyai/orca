import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { tryDispatchRemoteLinearProjectWriteCli } from './ssh-remote-linear-project-write-cli'
import { tryDispatchRemoteLinearWriteCli } from './ssh-remote-linear-write-cli'
import { getRemoteLinearHelp } from './ssh-remote-linear-cli'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

function createDispatcher() {
  const dispatch = vi.fn().mockResolvedValue({
    id: 'response-1',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-1' }
  })
  return { dispatch, dispatcher: { dispatch } as unknown as RpcDispatcher }
}

async function dispatchProjectWrite(argv: string[], stdin?: string) {
  const { dispatch, dispatcher } = createDispatcher()
  const response = await tryDispatchRemoteLinearProjectWriteCli(
    dispatcher,
    parseRemoteCliArgs(argv),
    stdin
  )
  return { dispatch, response }
}

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

describe('SSH Linear project update add dispatch', () => {
  it('dispatches the pinned RPC method with the positional project target', async () => {
    const { dispatch } = await dispatchProjectWrite([
      'linear',
      'project',
      'update',
      'add',
      'launch-a1b2',
      '--body',
      'Shipped the beta'
    ])

    expect(dispatch).toHaveBeenCalledWith({
      id: expect.stringMatching(/^remote-cli-/),
      authToken: 'remote-cli',
      method: 'linear.agentProjectUpdateAdd',
      params: {
        input: 'launch-a1b2',
        workspaceId: undefined,
        body: 'Shipped the beta',
        isDiffHidden: false,
        writeId: undefined
      }
    })
  })

  it('forwards --id, normalized health, hide-diff, stdin body, and the write id', async () => {
    const { dispatch } = await dispatchProjectWrite(
      [
        'linear',
        'project',
        'update',
        'add',
        '--id',
        'Launch',
        '--body-file',
        '-',
        '--health',
        'at-risk',
        '--hide-diff',
        '--write-id',
        '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        '--workspace',
        'workspace-1',
        '--json'
      ],
      'Slipping a week'
    )

    expect(dispatch.mock.calls[0][0]).toMatchObject({
      method: 'linear.agentProjectUpdateAdd',
      params: {
        input: 'Launch',
        workspaceId: 'workspace-1',
        body: 'Slipping a week',
        health: 'atRisk',
        isDiffHidden: true,
        writeId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
      }
    })
  })

  it('ignores project commands it does not own', async () => {
    const { dispatch, response } = await dispatchProjectWrite([
      'linear',
      'project',
      'show',
      'launch'
    ])

    expect(response).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes through the Linear write dispatcher before its existing branches', async () => {
    const { dispatch, dispatcher } = createDispatcher()

    await tryDispatchRemoteLinearWriteCli(
      dispatcher,
      parseRemoteCliArgs(['linear', 'project', 'update', 'add', 'launch-a1b2', '--body', 'Done']),
      {},
      undefined
    )

    expect(dispatch.mock.calls[0][0].method).toBe('linear.agentProjectUpdateAdd')
  })
})

describe('SSH Linear project update add argument rejection', () => {
  it('rejects a remote --body-file path other than stdin', async () => {
    await expect(
      dispatchProjectWrite(
        ['linear', 'project', 'update', 'add', 'launch-a1b2', '--body-file', '/etc/passwd'],
        'ignored'
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes only support --body-file - for stdin.'
    })
  })

  it('rejects --body-file - when no stdin was piped', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--body-file',
        '-'
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes require stdin when using --body-file -.'
    })
  })

  it('rejects an empty body before dispatching', async () => {
    const { dispatch, dispatcher } = createDispatcher()

    await expect(
      tryDispatchRemoteLinearProjectWriteCli(
        dispatcher,
        parseRemoteCliArgs(['linear', 'project', 'update', 'add', 'launch-a1b2', '--body=']),
        undefined
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects an unknown flag naming the flag and the command', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--body',
        'Done',
        '--content',
        'nope'
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --content for command: linear project update add'
    })
  })

  it('rejects camelCase --health spellings with the CLI values', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--body',
        'Done',
        '--health',
        'atRisk'
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--health must be on-track, at-risk, off-track'
    })
  })

  it('rejects a positional project target combined with --id', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--id',
        'other',
        '--body',
        'Done'
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass --id either positionally or as a flag, not both.'
    })
  })

  it('requires a project target', async () => {
    await expect(
      dispatchProjectWrite(['linear', 'project', 'update', 'add', '--body', 'Done'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass a project as a positional argument or --id <project>'
    })
  })

  it('rejects --workspace all for the write', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--body',
        'Done',
        '--workspace',
        'all'
      ])
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      message: '--workspace all is not valid for Linear writes'
    })
  })

  it('rejects a non-UUID --write-id', async () => {
    await expect(
      dispatchProjectWrite([
        'linear',
        'project',
        'update',
        'add',
        'launch-a1b2',
        '--body',
        'Done',
        '--write-id',
        'not-a-uuid'
      ])
    ).rejects.toMatchObject({ code: 'linear_invalid_write_id' })
  })
})

describe('SSH Linear parsing after adding --hide-diff', () => {
  it('treats --hide-diff as boolean without swallowing the project positional', async () => {
    const { dispatch } = await dispatchProjectWrite([
      'linear',
      'project',
      'update',
      'add',
      '--hide-diff',
      'launch-a1b2',
      '--body',
      'Done'
    ])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({
      input: 'launch-a1b2',
      isDiffHidden: true
    })
  })

  it('keeps repeatable and boolean parsing for existing commands', () => {
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

    expect(listIssues.flags.get('label')).toBe('Bug\u0000Growth')
    expect(listIssues.flags.get('include-archived')).toBe(true)
    expect(issue.flags.get('activity')).toBe(true)
    expect(issue.commandPath).toEqual(['linear', 'issue', 'ENG-123'])
  })

  it('keeps the existing comment add body contract after parameterizing the body reader', async () => {
    const { dispatch, dispatcher } = createDispatcher()

    await tryDispatchRemoteLinearWriteCli(
      dispatcher,
      parseRemoteCliArgs(['linear', 'comment', 'add', 'ENG-123', '--body-file', '-']),
      {},
      'Piped comment'
    )
    await expect(
      tryDispatchRemoteLinearWriteCli(
        dispatcher,
        parseRemoteCliArgs(['linear', 'comment', 'add', 'ENG-123', '--body-file', '/etc/passwd']),
        {},
        'Piped comment'
      )
    ).rejects.toMatchObject({
      message: 'SSH Linear writes only support --body-file - for stdin.'
    })

    expect(dispatch.mock.calls[0][0]).toMatchObject({
      method: 'linear.issueAddComment',
      params: { body: 'Piped comment' }
    })
  })

  it('still dispatches existing project list reads end to end', async () => {
    const result = await runRemoteOrcaCli(createRuntime(), {
      argv: ['linear', 'project', 'list', '--query', 'launch', '--limit', '5', '--json'],
      cwd: '/home/alice/remote-repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).ok).toBe(true)
  })
})

describe('SSH Linear project update add help', () => {
  it('prints leaf help for the write command', () => {
    const help = getRemoteLinearHelp(
      parseRemoteCliArgs(['linear', 'project', 'update', 'add', '--help'])
    )

    expect(help).toContain('Usage: orca linear project update add (<project> | --id <project>)')
    expect(help).toContain('(--body <text> | --body-file -)')
    expect(help).toContain('--health on-track|at-risk|off-track')
    expect(help).toContain('--hide-diff')
    expect(help).toContain('--write-id <uuid>')
  })

  it('keeps the project update group help pointing at its leaf', () => {
    const help = getRemoteLinearHelp(parseRemoteCliArgs(['linear', 'project', 'update', '--help']))

    expect(help).toContain('Usage: orca linear project update <command> [options]')
    expect(help).toContain('add')
  })
})
