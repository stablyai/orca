import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch as dispatchCliCommand } from '../../dispatch/dispatch'
import { RuntimeClient } from '../../runtime/client'
import { findCommandSpec } from '../../arguments/args'
import { COMMAND_SPECS } from '../../specs'
import { formatCommandHelp } from '../../discovery/help'
import { BUNDLED_SKILL_GUIDES } from '../../skills/bundled-skill-guides'
import { WORKER_SHOW_VIEW } from '../workers/worker-agent-views'

describe('orchestration task-update --note CLI and help contract', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function fakeClient(
    onCall: (method: string, params: unknown) => unknown = () => ({
      task: { id: 'task_1', status: 'dispatched' },
      dispatchId: 'ctx_1',
      progressNote: 'checks green',
      progressUpdatedAt: '2026-11-26T18:00:00.000Z'
    })
  ): RuntimeClient {
    const client = new RuntimeClient('/tmp/orca-unused', 1_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async (method: string, params?: unknown) => ({
      id: 'req_1',
      ok: true,
      result: onCall(method, params),
      _meta: { runtimeId: 'rt_1' }
    }))
    return client
  }

  it('removes the progress verb completely and validates task-update --note / --note-file before calling orchestration.taskUpdate', async () => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_PANE_KEY', '')

    expect(findCommandSpec(COMMAND_SPECS, ['orchestration', 'progress'])).toBeUndefined()
    const unusedClient = fakeClient()
    await expect(
      dispatchCliCommand(['orchestration', 'progress'], {
        flags: new Map([['note', 'retired']]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toThrow(/Unknown command/)

    // Outside a worker context with no --id and no --from, rejects before any RPC call.
    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([['note', 'running checks']]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message: expect.stringContaining(
        'send = always wakes the recipient; task-update --note = passive, never wakes.'
      )
    })

    // Rejects missing --status and --note, --result without --status, empty --note, and >500-char --note locally.
    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([['id', 'task_1']]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose --status, --note (or --note-file), or both.'
    })

    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([
          ['from', 'term_worker'],
          ['note', 'running'],
          ['result', 'not allowed alone']
        ]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--result requires --status.'
    })

    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([
          ['from', 'term_worker'],
          ['note', '   ']
        ]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--note cannot be empty.'
    })

    await expect(
      dispatchCliCommand(['orchestration', 'task-update'], {
        flags: new Map([
          ['from', 'term_worker'],
          ['note', 'a'.repeat(501)]
        ]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('at most 500 characters')
    })
    expect(unusedClient.call).not.toHaveBeenCalled()

    // Reads --note-file with no --id and no --status, leaving status untouched on the RPC call.
    const dir = mkdtempSync(join(tmpdir(), 'orca-task-update-cli-'))
    dirs.push(dir)
    const notePath = join(dir, 'note.txt')
    writeFileSync(notePath, '  verifying migration v52  \n', 'utf8')
    const calls: { method: string; params: unknown }[] = []
    const client = fakeClient((method, params) => {
      calls.push({ method, params })
      return {
        task: { id: 'task_1', status: 'dispatched' },
        dispatchId: 'ctx_1',
        progressNote: 'verifying migration v52',
        progressUpdatedAt: '2026-11-26T18:00:00.000Z'
      }
    })
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })

    await dispatchCliCommand(['orchestration', 'task-update'], {
      flags: new Map([
        ['from', 'orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec'],
        ['note-file', notePath]
      ]),
      client,
      cwd: dir,
      json: true
    })

    expect(calls).toEqual([
      {
        method: 'orchestration.taskUpdate',
        params: {
          id: undefined,
          status: undefined,
          result: undefined,
          note: 'verifying migration v52',
          run: undefined,
          callerTerminalHandle: 'orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec',
          senderPaneKey: undefined
        }
      }
    ])
    expect(JSON.parse(printed[0]!)).toMatchObject({
      ok: true,
      result: {
        taskId: 'task_1',
        status: 'dispatched',
        dispatchId: 'ctx_1',
        note: 'verifying migration v52'
      }
    })
  })

  it('surfaces passive progress in worker-show and states the one-line send vs task-update --note rule across help and skill guides', () => {
    const view = WORKER_SHOW_VIEW.fields({
      dispatch: {
        id: 'ctx_1',
        taskId: 'task_1',
        status: 'dispatched',
        progressNote: 'running targeted tests',
        progressUpdatedAt: '2026-11-26T18:00:00.000Z'
      },
      worker: { state: 'ready', stage: 'ready', agentTerminalHandle: 'term_worker' }
    })
    expect(view).toMatchObject({
      dispatchId: 'ctx_1',
      progress: 'running targeted tests',
      progressUpdatedAt: '2026-11-26T18:00:00.000Z'
    })

    const sendSpec = findCommandSpec(COMMAND_SPECS, ['orchestration', 'send'])
    const taskUpdateSpec = findCommandSpec(COMMAND_SPECS, ['orchestration', 'task-update'])
    expect(sendSpec?.allowedFlags).not.toContain('wake')
    expect(formatCommandHelp(sendSpec!)).toContain(
      'send = always wakes the recipient; task-update --note = passive, never wakes.'
    )
    expect(formatCommandHelp(taskUpdateSpec!)).toContain(
      'send = always wakes the recipient; task-update --note = passive, never wakes.'
    )
    expect(formatCommandHelp(taskUpdateSpec!)).toContain('never changes task status')

    const orchGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orchestration')
    const cliGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orca-cli')
    expect(orchGuide?.markdown).toContain(
      '`send` = always wakes the recipient; `task-update --note` = passive, never wakes.'
    )
    expect(orchGuide?.markdown).toContain('ORCA orchestration task-update --note')
    expect(orchGuide?.markdown).not.toContain('orchestration progress')
    expect(cliGuide?.markdown).toContain(
      '`send` = always wakes the recipient; `task-update --note` = passive, never wakes.'
    )
    expect(cliGuide?.markdown).not.toContain('orchestration progress')
  })
})
