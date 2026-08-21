import { describe, expect, it, vi } from 'vitest'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import { getRemoteLinearHelp } from './ssh-remote-linear-cli'
import { tryDispatchRemoteLinearProjectWriteCli } from './ssh-remote-linear-project-write-cli'

function createDispatcher() {
  const dispatch = vi.fn().mockResolvedValue({
    id: 'response-1',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-1' }
  })
  return { dispatch, dispatcher: { dispatch } as unknown as RpcDispatcher }
}

async function dispatchEdit(argv: string[], stdin?: string) {
  const { dispatch, dispatcher } = createDispatcher()
  await tryDispatchRemoteLinearProjectWriteCli(dispatcher, parseRemoteCliArgs(argv), stdin)
  return dispatch
}

const TARGET = ['linear', 'project', 'edit', 'launch-a1b2']

describe('SSH Linear project edit dispatch', () => {
  it('dispatches the pinned RPC method with unresolved reference inputs', async () => {
    const dispatch = await dispatchEdit([
      ...TARGET,
      '--name',
      '  Launch  ',
      '--description',
      'Short summary',
      '--content',
      '# Brief',
      '--status',
      'In Progress',
      '--lead',
      'me',
      '--member',
      'me',
      '--member',
      'ada@example.com',
      '--team',
      'ENG',
      '--team',
      'DES',
      '--label',
      'Growth',
      '--priority',
      'none',
      '--start-date',
      '2026-03-01',
      '--target-date',
      '2026-04-01',
      '--color',
      '#A1B2C3',
      '--workspace',
      'workspace-1',
      '--json'
    ])

    expect(dispatch).toHaveBeenCalledWith({
      id: expect.stringMatching(/^remote-cli-/),
      authToken: 'remote-cli',
      method: 'linear.agentProjectEdit',
      params: {
        input: 'launch-a1b2',
        name: 'Launch',
        description: 'Short summary',
        content: '# Brief',
        status: 'In Progress',
        lead: 'me',
        members: ['me', 'ada@example.com'],
        teams: ['ENG', 'DES'],
        labels: ['Growth'],
        priority: 0,
        startDate: '2026-03-01',
        targetDate: '2026-04-01',
        color: '#A1B2C3',
        workspaceId: 'workspace-1'
      }
    })
  })

  it('sends every clear flag with its own empty representation', async () => {
    const dispatch = await dispatchEdit([
      'linear',
      'project',
      'edit',
      '--id',
      'Launch',
      '--clear-description',
      '--clear-content',
      '--clear-lead',
      '--clear-members',
      '--clear-labels',
      '--clear-start-date',
      '--clear-target-date'
    ])

    expect(dispatch.mock.calls[0][0].params).toEqual({
      input: 'Launch',
      description: '',
      content: null,
      lead: null,
      members: [],
      labels: [],
      startDate: null,
      targetDate: null,
      workspaceId: undefined
    })
  })

  it('keeps a leading clear flag from swallowing the project positional', async () => {
    const dispatch = await dispatchEdit([
      'linear',
      'project',
      'edit',
      '--clear-lead',
      'launch-a1b2',
      '--name',
      'Launch'
    ])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({
      input: 'launch-a1b2',
      lead: null,
      name: 'Launch'
    })
  })

  it('omits fields that were not requested and never sends a write id', async () => {
    const dispatch = await dispatchEdit([...TARGET, '--priority', 'urgent'])

    expect(Object.keys(dispatch.mock.calls[0][0].params).sort()).toEqual([
      'input',
      'priority',
      'workspaceId'
    ])
  })

  it('reads content from stdin without trimming it', async () => {
    const dispatch = await dispatchEdit([...TARGET, '--content-file', '-'], '  # Brief\n')

    expect(dispatch.mock.calls[0][0].params).toMatchObject({ content: '  # Brief\n' })
  })

  it('keeps an explicitly empty description as a meaningful value', async () => {
    const dispatch = await dispatchEdit([...TARGET, '--description='])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({ description: '' })
  })

  it('deduplicates repeated collection values while replacing the collection', async () => {
    const dispatch = await dispatchEdit([
      ...TARGET,
      '--label',
      'Growth',
      '--label',
      'Growth',
      '--label',
      'Beta'
    ])

    expect(dispatch.mock.calls[0][0].params).toMatchObject({ labels: ['Growth', 'Beta'] })
  })
})

describe('SSH Linear project edit value and clear exclusivity', () => {
  const conflicts: [string, string, string[]][] = [
    ['description', 'clear-description', ['--description', 'x']],
    ['content', 'clear-content', ['--content', 'x']],
    ['content-file', 'clear-content', ['--content-file', '-']],
    ['lead', 'clear-lead', ['--lead', 'me']],
    ['member', 'clear-members', ['--member', 'me']],
    ['label', 'clear-labels', ['--label', 'Growth']],
    ['start-date', 'clear-start-date', ['--start-date', '2026-03-01']],
    ['target-date', 'clear-target-date', ['--target-date', '2026-03-01']]
  ]

  for (const [valueFlag, clearFlag, argv] of conflicts) {
    it(`rejects --${valueFlag} together with --${clearFlag}`, async () => {
      await expect(
        dispatchEdit([...TARGET, ...argv, `--${clearFlag}`], 'piped')
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: `Use either --${valueFlag} or --${clearFlag}, not both`
      })
    })
  }

  it('rejects a clear flag given a value that is not a boolean', async () => {
    await expect(dispatchEdit([...TARGET, '--clear-lead=maybe'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--clear-lead is a boolean flag; pass --clear-lead on its own, or --clear-lead=true or --clear-lead=false.'
    })
  })

  // Why: the local CLI coerces these; leaving the shim uncoerced made `--clear-lead=true`
  // read as off over SSH and silently keep the lead the caller asked to drop.
  it('clears the field for an explicit --clear-lead=true, as the local CLI does', async () => {
    const dispatch = await dispatchEdit([...TARGET, '--clear-lead=true'])

    expect(dispatch.mock.calls[0][0].params).toEqual({
      input: 'launch-a1b2',
      lead: null,
      workspaceId: undefined
    })
  })

  it('leaves the field untouched for --clear-lead=false, as the local CLI does', async () => {
    const dispatch = await dispatchEdit([...TARGET, '--clear-lead=false', '--name', 'Renamed'])

    expect(dispatch.mock.calls[0][0].params).toEqual({
      input: 'launch-a1b2',
      name: 'Renamed',
      workspaceId: undefined
    })
  })
})

describe('SSH Linear project edit argument rejection', () => {
  it('rejects a remote --content-file path other than stdin', async () => {
    await expect(
      dispatchEdit([...TARGET, '--content-file', '/etc/passwd'], 'ignored')
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes only support --content-file - for stdin.'
    })
  })

  it('rejects --content-file - when no stdin was piped', async () => {
    await expect(dispatchEdit([...TARGET, '--content-file', '-'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'SSH Linear writes require stdin when using --content-file -.'
    })
  })

  it('rejects --write-id because project edit cannot dedup a retry', async () => {
    await expect(
      dispatchEdit([
        ...TARGET,
        '--name',
        'Launch',
        '--write-id',
        'f81d4fae-7dec-41d0-a765-00a0c91e6bf6'
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --write-id for command: linear project edit'
    })
  })

  it('rejects the clear flags Linear cannot represent', async () => {
    for (const flag of ['clear-status', 'clear-color', 'clear-teams']) {
      await expect(dispatchEdit([...TARGET, `--${flag}`])).rejects.toMatchObject({
        code: 'invalid_argument',
        message: `Unknown flag --${flag} for command: linear project edit`
      })
    }
  })

  it('rejects an empty team replacement', async () => {
    await expect(dispatchEdit([...TARGET, '--team='])).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--team replaces the whole collection and needs at least one value; a project edit cannot remove every team'
    })
  })

  it('rejects an empty member or label replacement and points at the clear flag', async () => {
    await expect(dispatchEdit([...TARGET, '--member='])).rejects.toMatchObject({
      message:
        '--member replaces the whole collection and needs at least one value; use --clear-members to empty it'
    })
    await expect(dispatchEdit([...TARGET, '--label='])).rejects.toMatchObject({
      message:
        '--label replaces the whole collection and needs at least one value; use --clear-labels to empty it'
    })
  })

  it('rejects an edit that requests no field at all', async () => {
    await expect(dispatchEdit([...TARGET, '--json'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass at least one field flag or --clear-* flag to edit a Linear project'
    })
  })

  it('requires a project target and rejects a positional combined with --id', async () => {
    await expect(
      dispatchEdit(['linear', 'project', 'edit', '--name', 'Launch'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass a Linear project UUID, slugId, URL, or exact name positionally or as --id'
    })
    await expect(
      dispatchEdit([...TARGET, '--id', 'other', '--name', 'Launch'])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Pass --id either positionally or as a flag, not both.'
    })
  })

  it('rejects --workspace all for the edit write', async () => {
    await expect(
      dispatchEdit([...TARGET, '--name', 'Launch', '--workspace', 'all'])
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      message: '--workspace all is not valid for Linear writes'
    })
  })

  it('rejects a blank name, bad priority, colors, and impossible calendar dates', async () => {
    await expect(dispatchEdit([...TARGET, '--name', '   '])).rejects.toMatchObject({
      message: '--name must not be blank'
    })
    await expect(dispatchEdit([...TARGET, '--priority', 'p1'])).rejects.toMatchObject({
      message: '--priority must be none, low, medium, high, or urgent'
    })
    await expect(dispatchEdit([...TARGET, '--color', 'A1B2C3'])).rejects.toMatchObject({
      message: '--color must be #RRGGBB, quoted so the shell keeps the leading #'
    })
    await expect(dispatchEdit([...TARGET, '--start-date', '2026-02-30'])).rejects.toMatchObject({
      message: '--start-date must be a real calendar date'
    })
    await expect(dispatchEdit([...TARGET, '--target-date', '04-01-2026'])).rejects.toMatchObject({
      message: '--target-date must use YYYY-MM-DD'
    })
  })

  it('rejects an unknown flag naming the flag and the command', async () => {
    await expect(dispatchEdit([...TARGET, '--body', 'nope'])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown flag --body for command: linear project edit'
    })
  })
})

describe('SSH Linear project edit help', () => {
  it('prints leaf help stating replace, clear, and read-back verification', () => {
    const help = getRemoteLinearHelp(parseRemoteCliArgs(['linear', 'project', 'edit', '--help']))

    expect(help).toContain('Usage: orca linear project edit (<project> | --id <project>)')
    expect(help).toContain('[--description <text> | --clear-description]')
    expect(help).toContain('[--content <text> | --content-file - | --clear-content]')
    expect(help).toContain('[--member <user>... | --clear-members]')
    expect(help).toContain('replace the complete collection')
    expect(help).toContain('Status, color and teams have no clear flag.')
    expect(help).toContain('There is no --write-id')
  })

  it('lists edit in the project group help', () => {
    const help = getRemoteLinearHelp(parseRemoteCliArgs(['linear', 'project', '--help']))

    expect(help).toContain('edit          Edit Linear project fields')
  })
})
