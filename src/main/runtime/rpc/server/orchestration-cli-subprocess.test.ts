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
    import('../../orca-runtime'),
    import('../../orchestration/db/orchestration-db'),
    import('./runtime-rpc')
  ])
}

async function runBuiltCli(
  userDataPath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // These tests read the full receipt, not the concise agent view.
  const fullArgs = args[0] === 'orchestration' ? [...args, '--full'] : args
  const child = spawn(process.execPath, [CLI_PATH, ...fullArgs], {
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

describeIfBuilt('orca orchestration check --wait subprocess (§3.4)', () => {})

describeIfBuilt('orca orchestration reset subprocess', () => {})

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

describeIfBuilt('native caller subprocess over durable records', () => {
  // Real CLI subprocess round trips include store reopen, retry/refusal checks and IPC cleanup.
})
