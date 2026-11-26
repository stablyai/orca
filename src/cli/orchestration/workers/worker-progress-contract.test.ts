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
import { WORKER_SHOW_VIEW } from './worker-agent-views'

describe('orchestration progress CLI and prompt contract', () => {
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
      dispatchId: 'ctx_1',
      taskId: 'task_1',
      runId: 'run_1',
      note: 'checks green',
      updatedAt: '2026-11-25T18:00:00.000Z'
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

  it('validates bounded notes, caller context, and --note-file before calling orchestration.progress', async () => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_PANE_KEY', '')

    // Outside a worker context with no --from, rejects before any RPC call.
    const unusedClient = fakeClient()
    await expect(
      dispatchCliCommand(['orchestration', 'progress'], {
        flags: new Map([['note', 'running checks']]),
        client: unusedClient,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message: expect.stringContaining('orca orchestration send')
    })
    expect(unusedClient.call).not.toHaveBeenCalled()

    // Rejects empty and >500-character notes locally.
    await expect(
      dispatchCliCommand(['orchestration', 'progress'], {
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
      dispatchCliCommand(['orchestration', 'progress'], {
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

    // Reads --note-file and sends trimmed note to orchestration.progress.
    const dir = mkdtempSync(join(tmpdir(), 'orca-progress-cli-'))
    dirs.push(dir)
    const notePath = join(dir, 'note.txt')
    writeFileSync(notePath, '  verifying migration v52  \n', 'utf8')
    const calls: { method: string; params: unknown }[] = []
    const client = fakeClient((method, params) => {
      calls.push({ method, params })
      return {
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        runId: 'run_1',
        note: 'verifying migration v52',
        updatedAt: '2026-11-25T18:00:00.000Z'
      }
    })
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })

    await dispatchCliCommand(['orchestration', 'progress'], {
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
        method: 'orchestration.progress',
        params: {
          from: 'orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec',
          note: 'verifying migration v52',
          dispatchId: undefined,
          senderPaneKey: undefined
        }
      }
    ])
    expect(JSON.parse(printed[0]!)).toMatchObject({
      ok: true,
      result: {
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        progress: 'verifying migration v52'
      }
    })
  })

  it('surfaces passive progress in worker-show view and keeps send wake-only across CLI specs, preambles, and skill guides', () => {
    const view = WORKER_SHOW_VIEW.fields({
      dispatch: {
        id: 'ctx_1',
        taskId: 'task_1',
        status: 'dispatched',
        progressNote: 'running targeted tests',
        progressUpdatedAt: '2026-11-25T18:00:00.000Z'
      },
      worker: { state: 'ready', stage: 'ready', agentTerminalHandle: 'term_worker' }
    })
    expect(view).toMatchObject({
      dispatchId: 'ctx_1',
      progress: 'running targeted tests',
      progressUpdatedAt: '2026-11-25T18:00:00.000Z'
    })

    const sendSpec = findCommandSpec(COMMAND_SPECS, ['orchestration', 'send'])
    const progressSpec = findCommandSpec(COMMAND_SPECS, ['orchestration', 'progress'])
    expect(sendSpec?.allowedFlags).not.toContain('wake')
    expect(formatCommandHelp(sendSpec!)).toContain('always wakes the recipient')
    expect(formatCommandHelp(sendSpec!)).toContain('orca orchestration progress --note')
    expect(formatCommandHelp(progressSpec!)).toContain('Never inserts coordinator mail')

    const orchGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orchestration')
    const cliGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orca-cli')
    expect(orchGuide?.markdown).toContain('`ORCA orchestration send` always wakes its')
    expect(orchGuide?.markdown).toContain('ORCA orchestration progress --note')
    expect(cliGuide?.markdown).toContain('`orchestration send` always wakes the recipient')
  })
})
