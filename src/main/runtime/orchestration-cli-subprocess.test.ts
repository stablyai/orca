// Exercise compiled CLI keepalives over pipes; skip until built (the verification gate builds it).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

function loadRuntimeModules() {
  return Promise.all([
    import('./orca-runtime'),
    import('./orchestration/db'),
    import('./runtime-rpc')
  ])
}

async function runBuiltCli(
  userDataPath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_TERMINAL_HANDLE: 'term_cli',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))

  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('exit', (code) => resolveExit(code ?? 1))
    child.once('error', rejectExit)
  })

  return {
    exitCode,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join('')
  }
}

describeIfBuilt('orca orchestration check --wait subprocess (§3.4)', () => {
  it('emits newline-flushed JSON keepalives to stderr while waiting', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-sub-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    // A consuming inbox check requires a live pane, even when no messages exist.
    const paneKey = 'tab_keepalive:11111111-1111-4111-8111-111111111111'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_nobody' ? paneKey : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      // Shorten the keepalive interval to keep the subprocess test near one second.
      const keepaliveMs = 200
      const waitTimeoutMs = 1200

      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          'orchestration',
          'check',
          '--wait',
          '--timeout-ms',
          String(waitTimeoutMs),
          '--json'
        ],
        {
          env: {
            ...process.env,
            ORCA_USER_DATA_PATH: userDataPath,
            ORCA_TERMINAL_HANDLE: 'term_nobody',
            ORCA_KEEPALIVE_INTERVAL_MS: String(keepaliveMs)
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      const stderrChunks: { at: number; data: string }[] = []
      const stdoutChunks: { at: number; data: string }[] = []
      const startedAt = Date.now()
      child.stderr.setEncoding('utf8')
      child.stdout.setEncoding('utf8')
      child.stderr.on('data', (d) => stderrChunks.push({ at: Date.now() - startedAt, data: d }))
      child.stdout.on('data', (d) => stdoutChunks.push({ at: Date.now() - startedAt, data: d }))

      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code ?? 1))
        child.once('error', rejectExit)
      })

      const stderr = stderrChunks.map((c) => c.data).join('')
      const stdout = stdoutChunks.map((c) => c.data).join('')
      expect(exitCode, stderr).toBe(0)

      const keepaliveLines = stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((p): p is Record<string, unknown> => p !== null && p._keepalive === true)

      expect(keepaliveLines.length).toBeGreaterThanOrEqual(3)
      expect(keepaliveLines[0]).toMatchObject({ _keepalive: true, _heartbeat: true })
      expect(keepaliveLines[0]).toHaveProperty('elapsedMs')
      expect(keepaliveLines[0]).toHaveProperty('deadlineMs', waitTimeoutMs)

      // Under load, startup can exceed one interval; require a keepalive before terminal stdout.
      const firstKeepaliveChunk = stderrChunks.find((c) => c.data.includes('_keepalive'))
      expect(firstKeepaliveChunk).toBeDefined()
      expect(firstKeepaliveChunk!.at).toBeLessThan(stdoutChunks[0]?.at ?? Number.POSITIVE_INFINITY)

      // Separate stderr events before exit prove line flushing rather than exit-time buffering.
      const lastStderrAt = stderrChunks.at(-1)?.at ?? 0
      const firstStderrAt = stderrChunks.at(0)?.at ?? 0
      expect(lastStderrAt).toBeGreaterThan(firstStderrAt)

      const stdoutTrimmed = stdout.trim()
      const stdoutPayload = JSON.parse(stdoutTrimmed) as Record<string, unknown>
      expect(stdoutPayload).not.toHaveProperty('_keepalive')
      expect(stdoutTrimmed).not.toContain('_keepalive')
      expect(stdoutPayload).toMatchObject({ ok: true })

      // Each stderr keepalive must be one JSON line for merged-stream jq filtering.
      for (const line of stderr.split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        if (line.includes('_keepalive')) {
          expect(() => JSON.parse(line)).not.toThrow()
          expect(line).not.toContain('\n')
        }
      }
    } finally {
      db.close()
      await server.stop()
      vi.restoreAllMocks()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})

describeIfBuilt('orca orchestration reset subprocess', () => {
  it('validates reset scopes against an isolated runtime through the built CLI', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-reset-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_cli:11111111-1111-4111-8111-111111111111'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_cli'
        ? coordinatorPaneKey
        : handle === 'term_target'
          ? 'tab_target:33333333-3333-4333-8333-333333333333'
          : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    db.createRun({
      objective: 'CLI reset subprocess fixture',
      coordinatorHandle: 'term_cli',
      coordinatorPaneKey
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      const send = await runBuiltCli(userDataPath, [
        'orchestration',
        'send',
        '--to',
        'term_target',
        '--subject',
        'hello',
        '--json'
      ])
      expect(send.exitCode, send.stderr).toBe(0)

      const create = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'throwaway task',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(create.exitCode, create.stderr).toBe(0)
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const invalid = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--tasks',
        '--messages',
        '--json'
      ])
      expect(invalid.exitCode).toBe(1)
      const invalidPayload = JSON.parse(invalid.stdout) as {
        ok: boolean
        error: { code: string; message: string }
      }
      expect(invalidPayload.ok).toBe(false)
      expect(invalidPayload.error.code).toBe('invalid_argument')
      expect(invalidPayload.error.message).toContain('Choose exactly one reset scope')
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const resetTasks = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--tasks',
        '--json'
      ])
      expect(resetTasks.exitCode, resetTasks.stderr).toBe(0)
      expect(JSON.parse(resetTasks.stdout)).toMatchObject({ ok: true, result: { reset: 'tasks' } })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)

      // Reset removes Runs; recreate the caller binding before creating another task.
      db.createRun({
        objective: 'CLI reset subprocess fixture after reset',
        coordinatorHandle: 'term_cli',
        coordinatorPaneKey
      })
      const recreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'throwaway task after partial reset',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(recreate.exitCode, recreate.stderr).toBe(0)
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const bareReset = await runBuiltCli(userDataPath, ['orchestration', 'reset', '--json'])
      expect(bareReset.exitCode).toBe(1)
      expect(JSON.parse(bareReset.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const resetAll = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--all',
        '--json'
      ])
      expect(resetAll.exitCode, resetAll.stderr).toBe(0)
      expect(JSON.parse(resetAll.stdout)).toMatchObject({ ok: true, result: { reset: 'all' } })
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})

describeIfBuilt('orca orchestration task readiness subprocess', () => {
  it('creates a late dependent as ready through the built CLI and runtime', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-task-readiness-'))
    const dbPath = join(userDataPath, 'orchestration.db')
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(dbPath)
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_cli:22222222-2222-4222-8222-222222222222'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_cli' ? coordinatorPaneKey : null
    )
    db.createRun({
      objective: 'CLI late dependency readiness fixture',
      coordinatorHandle: 'term_cli',
      coordinatorPaneKey
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      const dependencyCreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'dependency',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(dependencyCreate.exitCode, dependencyCreate.stderr).toBe(0)
      const dependencyPayload = JSON.parse(dependencyCreate.stdout) as {
        result: { task: { id: string; status: string } }
      }
      const dependencyId = dependencyPayload.result.task.id

      const dependencyComplete = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-update',
        '--id',
        dependencyId,
        '--status',
        'completed',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(dependencyComplete.exitCode, dependencyComplete.stderr).toBe(0)

      const childCreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'late dependent',
        '--deps',
        JSON.stringify([dependencyId]),
        '--from',
        'term_cli',
        '--json'
      ])
      expect(childCreate.exitCode, childCreate.stderr).toBe(0)
      const childPayload = JSON.parse(childCreate.stdout) as {
        result: { task: { id: string; status: string } }
      }
      const child = childPayload.result.task
      expect(child.status).toBe('ready')

      const taskList = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-list',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(taskList.exitCode, taskList.stderr).toBe(0)
      const taskListPayload = JSON.parse(taskList.stdout) as {
        result: { tasks: { id: string; status: string }[] }
      }
      expect(taskListPayload.result.tasks).toContainEqual(
        expect.objectContaining({ id: child.id, status: 'ready' })
      )

      const persisted = new OrchestrationDb(dbPath)
      try {
        expect(persisted.getTask(child.id)?.status).toBe('ready')
      } finally {
        persisted.close()
      }
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})
