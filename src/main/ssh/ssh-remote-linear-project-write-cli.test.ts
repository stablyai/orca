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

    expect(listIssues.flags.get('label')).toBe('Growth')
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

describe('SSH Linear project create dispatch', () => {
  it('dispatches the pinned RPC method with unresolved reference inputs', async () => {
    const { dispatch } = await dispatchProjectWrite([
      'linear',
      'project',
      'create',
      '--name',
      '  Launch  ',
      '--team',
      'ENG',
      '--team',
      'DES',
      '--member',
      'me',
      '--member',
      'ada@example.com',
      '--label',
      'Growth',
      '--label',
      'Beta',
      '--status',
      'In Progress',
      '--lead',
      'me',
      '--priority',
      'none',
      '--start-date',
      '2026-03-01',
      '--target-date',
      '2026-04-01',
      '--color',
      '#A1B2C3',
      '--icon',
      'Rocket',
      '--workspace',
      'workspace-1',
      '--json'
    ])

    expect(dispatch).toHaveBeenCalledWith({
      id: expect.stringMatching(/^remote-cli-/),
      authToken: 'remote-cli',
      method: 'linear.agentProjectCreate',
      params: {
        name: 'Launch',
        teams: ['ENG', 'DES'],
        status: 'In Progress',
        lead: 'me',
        members: ['me', 'ada@example.com'],
        labels: ['Growth', 'Beta'],
        priority: 0,
        startDate: '2026-03-01',
        targetDate: '2026-04-01',
        color: '#A1B2C3',
        icon: 'Rocket',
        writeId: undefined,
        workspaceId: 'workspace-1'
      }
    })
  })

  it('keeps description and content untrimmed and reads content from stdin', async () => {
    const { dispatch } = await dispatchProjectWrite(
      [
        'linear',
        'project',
        'create',
        '--name',
        'Launch',
        '--team',
        'ENG',
        '--description=  ',
        '--content-file',
        '-'
      ],
      '  # Brief\n'
    )

    expect(dispatch.mock.calls[0][0].params).toMatchObject({
      description: '  ',
      content: '  # Brief\n'
    })
  })

  it('accepts a UUID v4 write id and routes through the Linear write dispatcher', async () => {
    const { dispatch, dispatcher } = createDispatcher()

    await tryDispatchRemoteLinearWriteCli(
      dispatcher,
      parseRemoteCliArgs([
        'linear',
        'project',
        'create',
        '--name',
        'Launch',
        '--team',
        'ENG',
        '--write-id',
        '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
      ]),
      {},
      undefined
    )

    expect(dispatch.mock.calls[0][0]).toMatchObject({
      method: 'linear.agentProjectCreate',
      params: { writeId: '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' }
    })
  })

  it('does not let a leading boolean flag swallow the first value flag', async () => {
    const { dispatch } = await dispatchProjectWrite([
      'linear',
      'project',
      'create',
      '--json',
      '--name',
      'Launch',
      '--team',
      'ENG'
    ])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({ name: 'Launch', teams: ['ENG'] })
  })
})

describe('SSH Linear project create argument rejection', () => {
  const base = ['linear', 'project', 'create', '--name', 'Launch', '--team', 'ENG']

  it('rejects a remote --content-file path other than stdin', async () => {
    await expect(
      dispatchProjectWrite([...base, '--content-file', '/etc/passwd'], 'ignored')
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes only support --content-file - for stdin.'
    })
  })

  it('rejects --content-file - when no stdin was piped', async () => {
    await expect(dispatchProjectWrite([...base, '--content-file', '-'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes require stdin when using --content-file -.'
    })
  })

  it('rejects --content together with --content-file', async () => {
    await expect(
      dispatchProjectWrite([...base, '--content', 'x', '--content-file', '-'], 'piped')
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Use either --content or --content-file, not both'
    })
  })

  it('rejects a non-v4 --write-id that project update add still accepts', async () => {
    const generic = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

    await expect(dispatchProjectWrite([...base, '--write-id', generic])).rejects.toMatchObject({
      code: 'linear_invalid_write_id',
      message: '--write-id must be a UUID v4'
    })

    const { dispatch } = await dispatchProjectWrite([
      'linear',
      'project',
      'update',
      'add',
      'launch-a1b2',
      '--body',
      'Done',
      '--write-id',
      generic
    ])
    expect(dispatch.mock.calls[0][0].params).toMatchObject({ writeId: generic })
  })

  it('requires --name and at least one --team', async () => {
    await expect(
      dispatchProjectWrite(['linear', 'project', 'create', '--team', 'ENG'])
    ).rejects.toMatchObject({ code: 'invalid_argument', message: 'Missing --name' })
    await expect(
      dispatchProjectWrite(['linear', 'project', 'create', '--name', '   ', '--team', 'ENG'])
    ).rejects.toMatchObject({ code: 'invalid_argument', message: '--name must not be empty' })
    await expect(
      dispatchProjectWrite(['linear', 'project', 'create', '--name', 'Launch'])
    ).rejects.toMatchObject({ code: 'invalid_argument', message: 'Missing required --team' })
  })

  it('rejects --workspace all for the create write', async () => {
    await expect(dispatchProjectWrite([...base, '--workspace', 'all'])).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      message: '--workspace all is not valid for Linear writes'
    })
  })

  it('rejects an unknown flag naming the flag and the command', async () => {
    await expect(dispatchProjectWrite([...base, '--body', 'nope'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --body for command: linear project create'
    })
    await expect(dispatchProjectWrite([...base, '--id', 'other'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --id for command: linear project create'
    })
  })

  it('rejects a positional target because create has none', async () => {
    await expect(
      dispatchProjectWrite(['linear', 'project', 'create', 'launch', '--team', 'ENG'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown command: linear project create launch'
    })
  })

  it('rejects bad priority, colors, and impossible calendar dates', async () => {
    await expect(dispatchProjectWrite([...base, '--priority', 'p1'])).rejects.toMatchObject({
      message: '--priority must be none, low, medium, high, or urgent'
    })
    await expect(dispatchProjectWrite([...base, '--color', 'A1B2C3'])).rejects.toMatchObject({
      message: '--color must be #RRGGBB'
    })
    await expect(
      dispatchProjectWrite([...base, '--start-date', '2026-02-30'])
    ).rejects.toMatchObject({ message: '--start-date must be a real calendar date' })
    await expect(
      dispatchProjectWrite([...base, '--target-date', '04-01-2026'])
    ).rejects.toMatchObject({ message: '--target-date must use YYYY-MM-DD' })
  })
})

describe('SSH Linear project create help', () => {
  it('prints leaf help for the create command', () => {
    const help = getRemoteLinearHelp(parseRemoteCliArgs(['linear', 'project', 'create', '--help']))

    expect(help).toContain('Usage: orca linear project create --name <title> --team <team>...')
    expect(help).toContain('[--content <text> | --content-file -]')
    expect(help).toContain('[--member <user>]...')
    expect(help).toContain('[--write-id <uuid-v4>]')
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
