import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { spawnProcess } from '../../shared/child-process/run-process'

const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')
const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

async function runBuiltCli(
  userDataPath: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawnProcess({
    program: process.execPath,
    args: [CLI_PATH, ...args],
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_TERMINAL_HANDLE: 'term_cli'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!child.stdout || !child.stderr) {
    throw new Error('Compiled CLI test requires piped stdout and stderr.')
  }
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1))
    child.once('error', reject)
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  }
}

function parseResult<T>(result: { exitCode: number; stdout: string; stderr: string }): T {
  expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
  return JSON.parse(result.stdout) as T
}

describeIfBuilt('Run capacity compiled CLI coordinator loop', () => {
  it('reopens one slot immediately after settlement and exposes the next enrolled Task', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-capacity-cli-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_cli:leaf_cli')
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockReturnValue('tab_cli:leaf_cli')
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      parseResult(
        await runBuiltCli(userDataPath, [
          'orchestration',
          'run-create',
          '--objective',
          'compiled capacity loop',
          '--from',
          'term_cli',
          '--json'
        ])
      )
      parseResult(
        await runBuiltCli(userDataPath, [
          'orchestration',
          'capacity-set',
          '--target',
          '1',
          '--from',
          'term_cli',
          '--json'
        ])
      )

      const tasks: string[] = []
      for (const spec of ['first lane', 'backfill lane']) {
        const created = parseResult<{ result: { task: { id: string } } }>(
          await runBuiltCli(userDataPath, [
            'orchestration',
            'task-create',
            '--spec',
            spec,
            '--from',
            'term_cli',
            '--json'
          ])
        )
        tasks.push(created.result.task.id)
        parseResult(
          await runBuiltCli(userDataPath, [
            'orchestration',
            'capacity-enroll',
            '--task',
            created.result.task.id,
            '--from',
            'term_cli',
            '--json'
          ])
        )
      }

      const before = parseResult<{
        result: { capacity: { availableSlots: number; launchableTasks: { id: string }[] } }
      }>(
        await runBuiltCli(userDataPath, [
          'orchestration',
          'capacity-show',
          '--from',
          'term_cli',
          '--json'
        ])
      )
      expect(before.result.capacity).toMatchObject({
        availableSlots: 1,
        launchableTasks: [{ id: tasks[0] }]
      })

      const started = db.createStartingWorkerDispatch({
        taskId: tasks[0]!,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1,
        capacitySlot: true
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_worker',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'pid:worker',
        worktreeId: 'repo::worktree',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.dispatch.id)

      const full = parseResult<{
        result: { capacity: { activeCount: number; availableSlots: number } }
      }>(
        await runBuiltCli(userDataPath, [
          'orchestration',
          'capacity-show',
          '--from',
          'term_cli',
          '--json'
        ])
      )
      expect(full.result.capacity).toMatchObject({ activeCount: 1, availableSlots: 0 })

      db.settleWorkerReport({
        taskId: tasks[0]!,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
      const reopened = parseResult<{
        result: {
          capacity: {
            activeCount: number
            availableSlots: number
            launchableTasks: { id: string }[]
            settledTerminalDebt: { dispatchId: string; terminalState: string }[]
          }
        }
      }>(
        await runBuiltCli(userDataPath, [
          'orchestration',
          'capacity-show',
          '--from',
          'term_cli',
          '--json'
        ])
      )
      expect(reopened.result.capacity).toMatchObject({
        activeCount: 0,
        availableSlots: 1,
        launchableTasks: [{ id: tasks[1] }],
        settledTerminalDebt: [{ dispatchId: started.dispatch.id, terminalState: 'reclaimable' }]
      })
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})
