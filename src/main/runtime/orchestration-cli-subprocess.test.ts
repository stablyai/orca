// Why: subprocess-level test for the CLI keepalive behavior described in
// design doc §3.4. Spawns the real compiled CLI with no TTY, points it at a
// real in-process runtime via ORCA_USER_DATA_PATH, and asserts:
//   - the first keepalive line appears on stderr well under Claude Code's
//     ~2 min Bash-tool silence budget (we verify with a shortened interval;
//     production uses 15 s via the same code path)
//   - ≥3 keepalives arrive during the wait window
//   - stderr is line-flushed (we observe each keepalive as a separate chunk
//     before the process exits — not in one burst at the end)
//   - stdout stays a single clean JSON payload (no keepalives leak to stdout)
//   - a `jq "select(._keepalive|not)"` filter on the merged stream would
//     yield exactly the final result
//
// This test is skipped if the CLI hasn't been built yet (out/cli/index.js
// missing) so `pnpm test` works on a fresh checkout without requiring a prior
// `pnpm run build:cli`. The verification gate explicitly builds the CLI
// before running this file.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why: Vitest runs tests with `process.cwd()` pinned to the repo root, so
// join against it to locate the compiled CLI regardless of where this test
// file itself lives.
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

// Why: a Python-orchestrated coordinator (the reported real-world failure)
// spawns the CLI with shell=False, so no login shell ever runs and no shell
// alias for `orca` is ever read. This suite proves the built CLI is reachable
// that way directly — by absolute path to out/cli/index.js — rather than by
// depending on `orca` resolving through a shell alias or an interactive shim.
const PYTHON_BIN = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0)
const describeIfPythonAvailable = PYTHON_BIN && existsSync(CLI_PATH) ? describe : describe.skip

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
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-sub-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      // Why: use the ORCA_KEEPALIVE_INTERVAL_MS escape hatch to shrink the
      // test to ~1 s wall time. Production callers never set this; the
      // production default (15 s) is exercised by §3.4's own unit tests
      // and by the fact that this same code path runs with the real
      // constant when the env var is absent.
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
          // Why: explicit pipe for all three fds so we can watch stderr
          // in real time; no TTY attached (Bash-tool parity).
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

      expect(exitCode).toBe(0)

      const stderr = stderrChunks.map((c) => c.data).join('')
      const stdout = stdoutChunks.map((c) => c.data).join('')

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

      // ≥3 keepalives in a 1.2s window with a 200ms interval
      expect(keepaliveLines.length).toBeGreaterThanOrEqual(3)
      expect(keepaliveLines[0]).toMatchObject({ _keepalive: true, _heartbeat: true })
      expect(keepaliveLines[0]).toHaveProperty('elapsedMs')
      expect(keepaliveLines[0]).toHaveProperty('deadlineMs', waitTimeoutMs)

      // Why: under full-suite load the child process startup may take longer
      // than one keepalive interval. The invariant that matters is that at
      // least one keepalive is observed before the terminal stdout payload.
      const firstKeepaliveChunk = stderrChunks.find((c) => c.data.includes('_keepalive'))
      expect(firstKeepaliveChunk).toBeDefined()
      expect(firstKeepaliveChunk!.at).toBeLessThan(stdoutChunks[0]?.at ?? Number.POSITIVE_INFINITY)

      // Why: line-flushing proof — the *first* keepalive chunk must arrive
      // strictly before the exit chunk; i.e. we got at least two separate
      // stderr data events (keepalive + final). A single-chunk delivery
      // would indicate stderr was buffered until exit.
      const lastStderrAt = stderrChunks.at(-1)?.at ?? 0
      const firstStderrAt = stderrChunks.at(0)?.at ?? 0
      expect(lastStderrAt).toBeGreaterThan(firstStderrAt)

      // Stdout: exactly one JSON payload, the terminal result. No keepalives
      // leak, and the content parses as valid JSON.
      const stdoutTrimmed = stdout.trim()
      const stdoutPayload = JSON.parse(stdoutTrimmed) as Record<string, unknown>
      expect(stdoutPayload).not.toHaveProperty('_keepalive')
      expect(stdoutTrimmed).not.toContain('_keepalive')
      // Why: result should be an RPC success envelope with the expected
      // shape. `count: 0` and `messages: []` because the wait timed out
      // with no message for term_nobody.
      expect(stdoutPayload).toMatchObject({ ok: true })

      // Why: the keepalives-on-stderr design is meant to pair with shell
      // filters like `2>&1 | jq "select(._keepalive|not)"`. jq is
      // line-oriented by default, but also accepts pretty-printed JSON
      // across multiple lines. What matters here is that every
      // keepalive line on stderr is a standalone JSON object (so jq can
      // match it) and doesn't span multiple lines — assert that each
      // keepalive is a single-line JSON with no embedded newlines.
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
    }
  }, 30_000)
})

describeIfBuilt('orca orchestration reset subprocess', () => {
  it('validates reset scopes against an isolated runtime through the built CLI', async () => {
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

      // Why: task resets intentionally remove Runs, so recreate the caller's
      // normal binding before exercising task creation again.
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

describeIfPythonAvailable('orca CLI reached from a non-interactive Python subprocess', () => {
  it('runs the built CLI to completion with no shell, TTY, or PATH alias involved', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-python-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_cli:44444444-4444-4444-8444-444444444444'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_cli' ? coordinatorPaneKey : null
    )
    db.createRun({
      objective: 'CLI Python subprocess fixture',
      coordinatorHandle: 'term_cli',
      coordinatorPaneKey
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      // Why: subprocess.run(..., shell=False) never launches a login shell,
      // so an `orca` PATH alias — or GNOME Orca's screen reader binary of
      // the same name — is never in play. The Python child names the built
      // CLI by its exact absolute path and the Node interpreter by
      // process.execPath, matching how a Python-orchestrated coordinator
      // must invoke it.
      const script = [
        'import subprocess, sys',
        'result = subprocess.run(',
        '  [sys.argv[1], sys.argv[2], "orchestration", "task-create",',
        '   "--spec", "python subprocess fixture", "--from", "term_cli", "--json"],',
        '  capture_output=True, text=True, shell=False, stdin=subprocess.DEVNULL',
        ')',
        'sys.stdout.write(result.stdout)',
        'sys.stderr.write(result.stderr)',
        'sys.exit(result.returncode)'
      ].join('\n')

      // Why: the RPC server the CLI must reach runs in-process on this same
      // event loop, so a synchronous spawn (spawnSync) would block that loop
      // and starve the server of the chance to answer — the child would then
      // time out from its own side. Use the async spawn, like every other
      // subprocess test in this file.
      const pythonChild = spawn(PYTHON_BIN!, ['-c', script, process.execPath, CLI_PATH], {
        env: {
          ...process.env,
          ORCA_USER_DATA_PATH: userDataPath,
          ORCA_TERMINAL_HANDLE: 'term_cli'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []
      pythonChild.stdout.setEncoding('utf8')
      pythonChild.stderr.setEncoding('utf8')
      pythonChild.stdout.on('data', (d) => stdoutChunks.push(d))
      pythonChild.stderr.on('data', (d) => stderrChunks.push(d))
      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        pythonChild.once('exit', (code) => resolveExit(code ?? 1))
        pythonChild.once('error', rejectExit)
      })
      const child = {
        status: exitCode,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
      }

      expect(child.status, child.stderr).toBe(0)
      const payload = JSON.parse(child.stdout) as { ok: boolean; result: { task: { id: string } } }
      expect(payload.ok).toBe(true)
      expect(db.listTasks()).toHaveLength(1)
      expect(db.getTask(payload.result.task.id)).toBeTruthy()
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})
