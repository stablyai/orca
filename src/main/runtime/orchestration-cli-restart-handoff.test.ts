import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrchestrationDb } from './orchestration/db'

const cliPath = join(process.cwd(), 'src/cli/index.ts')
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

const entity = z.object({ id: z.string() })
const check = z.object({
  result: z.object({
    runId: z.string(),
    deliveryId: z.string(),
    messages: z.array(z.object({ id: z.string() }).passthrough())
  })
})

function idOf(response: unknown, key: string): string {
  const { result } = z.object({ result: z.record(z.string(), z.unknown()) }).parse(response)
  return entity.parse(result[key]).id
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// Sequential source-CLI subprocesses and a disk-backed runtime restart exceed the default test budget.
it("retains CLI work and mail across restart, refuses a worker's own Run, and completes a separate Run handoff", async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-cli-restart-handoff-'))
  for (const name of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ORCA_E2E_HOME_DIR',
    'ORCA_E2E_USER_DATA_DIR',
    'ORCA_USER_DATA_PATH'
  ]) {
    vi.stubEnv(name, home)
  }
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('ORCA_DISABLE_MACOS_LOGIN_SHELL', '1')
  for (const name of [
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_AGENT_SESSION_ID',
    'ORCA_RUNTIME_SOURCE_ID',
    'ORCA_RUNTIME_SOURCE_INCARNATION',
    'ORCA_RUNTIME_SOURCE_PROFILE_PATH'
  ]) {
    vi.stubEnv(name, '')
  }
  const { OrcaRuntimeRpcServer } = await import('./runtime-rpc')
  const fixture = await import('./orchestration-mailbox-notification-test-harness')
  const { registerBoundPty } = await import('./bind-first-pane.test-fixture')
  const coord = fixture.TERMINAL_HANDLE
  const worker = fixture.SECOND_TERMINAL_HANDLE
  const predecessor = 'term_predecessor'
  const predecessorTab = '55555555-5555-4555-8555-555555555555'
  const predecessorLeaf = '66666666-6666-4666-8666-666666666666'
  let db = new OrchestrationDb(join(home, 'orchestration.db'))

  function runtimeForDatabase() {
    const { runtime } = fixture.createRuntime(db)
    fixture.registerSecondPane(runtime)
    registerBoundPty(runtime, 'pty-predecessor', fixture.WORKTREE_ID, null, {
      tabId: predecessorTab,
      leafId: predecessorLeaf,
      incarnationId: 'predecessor-incarnation'
    })
    runtime.registerPreAllocatedHandleForPty('pty-predecessor', predecessor)
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(2)
    return runtime
  }
  let runtime = runtimeForDatabase()
  let server = new OrcaRuntimeRpcServer({ runtime, userDataPath: home })
  async function cli(handle: string, args: string[], exitCode = 0): Promise<unknown> {
    const child = spawn(
      process.execPath,
      [
        '--import',
        tsxLoader,
        '--conditions=orca-source',
        cliPath,
        'orchestration',
        ...args,
        '--json',
        '--full'
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          ORCA_TERMINAL_HANDLE: handle,
          ORCA_PANE_KEY: runtime.getTerminalPaneKey(handle) ?? '',
          ORCA_AGENT_LAUNCH_TOKEN:
            handle === coord
              ? fixture.LAUNCH_TOKEN
              : handle === worker
                ? fixture.SECOND_LAUNCH_TOKEN
                : ''
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 15_000
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('close', resolveExit)
      child.once('error', rejectExit)
    })
    expect(code, JSON.stringify({ args, stdout, stderr })).toBe(exitCode)
    const response: unknown = JSON.parse(stdout)
    expect(response).toMatchObject({ ok: exitCode === 0 })
    return response
  }

  try {
    await server.start()
    const root = idOf(
      await cli(coord, ['run-create', '--objective', 'Retained parent work']),
      'run'
    )
    const task = idOf(await cli(coord, ['task-create', '--spec', 'Finish after restart']), 'task')
    const dispatch = idOf(
      await cli(coord, ['dispatch', '--task', task, '--to', worker]),
      'dispatch'
    )
    const separate = idOf(
      await cli(predecessor, ['run-create', '--objective', 'Predecessor work']),
      'run'
    )
    const continuation = idOf(
      await cli(predecessor, ['task-create', '--spec', 'Continue predecessor work']),
      'task'
    )
    const retainedMessage = idOf(
      await cli(worker, ['send', '--subject', 'Retain this report']),
      'message'
    )
    const retainedBatch = check.parse(await cli(coord, ['check'])).result
    expect(retainedBatch).toMatchObject({ runId: root, messages: [{ id: retainedMessage }] })

    await server.stop()
    db.close()
    db = new OrchestrationDb(join(home, 'orchestration.db'))
    runtime = runtimeForDatabase()
    server = new OrcaRuntimeRpcServer({ runtime, userDataPath: home })
    await server.start()
    expect(await cli(coord, ['run-current'])).toMatchObject({ result: { run: { id: root } } })
    expect(await cli(coord, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: task, status: 'dispatched', dispatch_id: dispatch }] }
    })
    expect(await cli(coord, ['check'])).toMatchObject({ result: { count: 0, deliveryId: null } })
    expect(await cli(coord, ['check', '--all'])).toMatchObject({
      result: { runId: root, messages: [{ id: retainedMessage }] }
    })

    const bindingBefore = db.getRunRaw(root)
    expect(await cli(worker, ['run-use', '--id', root], 1)).toMatchObject({
      error: { code: 'worker_cannot_coordinate_own_run', data: { effectsApplied: false } }
    })
    expect(db.getRunRaw(root)).toEqual(bindingBefore)
    expect(await cli(coord, ['check', '--ack', retainedBatch.deliveryId])).toMatchObject({
      result: { acknowledged: retainedBatch.deliveryId, count: 0 }
    })
    expect(await cli(worker, ['run-use', '--id', separate])).toMatchObject({
      result: { run: { id: separate } }
    })

    const question = idOf(
      await cli(worker, [
        'send',
        '--to',
        `run:${root}`,
        '--type',
        'question',
        '--subject',
        'Proceed with predecessor work?'
      ]),
      'message'
    )
    const questionBatch = check.parse(await cli(coord, ['check'])).result
    expect(questionBatch).toMatchObject({
      runId: root,
      messages: [{ id: question, type: 'question' }]
    })
    const reply = idOf(
      await cli(coord, ['reply', '--id', question, '--body', 'Proceed with the retained task']),
      'message'
    )
    const replyBatch = check.parse(await cli(worker, ['check'])).result
    expect(replyBatch).toMatchObject({
      runId: separate,
      messages: [
        {
          id: reply,
          thread_id: question,
          to_handle: `run:${separate}`,
          run_id: separate,
          body: 'Proceed with the retained task'
        }
      ]
    })
    expect(db.getMessageById(reply)?.read).toBe(1)
    expect(await cli(worker, ['check', '--ack', replyBatch.deliveryId])).toMatchObject({
      result: { runId: separate, acknowledged: replyBatch.deliveryId, count: 0 }
    })
    await cli(coord, ['check', '--ack', questionBatch.deliveryId])

    const continuedDispatch = idOf(
      await cli(worker, ['dispatch', '--task', continuation, '--to', predecessor]),
      'dispatch'
    )
    expect(
      await cli(predecessor, [
        'send',
        '--type',
        'worker_done',
        '--subject',
        'Predecessor work complete',
        '--payload',
        JSON.stringify({
          taskId: continuation,
          dispatchId: continuedDispatch,
          outcome: 'succeeded'
        })
      ])
    ).toMatchObject({ result: { lifecycle: { action: 'completed' } } })
    expect(await cli(worker, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: continuation, status: 'completed' }] }
    })
    expect(await cli(worker, ['dispatch-show', '--task', continuation])).toMatchObject({
      result: { dispatch: { id: continuedDispatch, status: 'completed' } }
    })

    expect(
      await cli(worker, [
        'send',
        '--type',
        'worker_done',
        '--subject',
        'Parent work complete',
        '--payload',
        JSON.stringify({ taskId: task, dispatchId: dispatch, outcome: 'succeeded' })
      ])
    ).toMatchObject({ result: { lifecycle: { action: 'completed' } } })
    expect(await cli(coord, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: task, status: 'completed' }] }
    })
    expect(await cli(coord, ['dispatch-show', '--task', task])).toMatchObject({
      result: { dispatch: { id: dispatch, status: 'completed' } }
    })
  } finally {
    await server.stop()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
