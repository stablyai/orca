import { runProcess } from '@orca/process-host'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const compiledCli = existsSync(cliPath)
const cliEntryArgs = compiledCli
  ? [cliPath]
  : [
      '--import',
      pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      '--conditions=orca-source',
      join(process.cwd(), 'src', 'cli', 'index.ts')
    ]
const entityResult = z.object({ result: z.record(z.string(), z.unknown()) })
const entity = z.object({ id: z.string() })

function idOf(response: unknown, key: string): string {
  return entity.parse(entityResult.parse(response).result[key]).id
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe(`Run ownership through the ${compiledCli ? 'compiled' : 'source'} CLI and real host`, () => {
  it('bounds explicit grants and lets a replacement inherit Task-owned Runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-run-ownership-cli-'))
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
    const { OrchestrationDb } = await import('./orchestration/db')
    const { OrcaRuntimeRpcServer } = await import('./runtime-rpc')
    const fixture = await import('./orchestration-mailbox-notification-test-harness')
    const { registerBoundPty } = await import('./bind-first-pane.test-fixture')
    const { getRunAuthority, getRunHandover } =
      await import('./orchestration/db/runs/run-authority-store')
    const db = new OrchestrationDb(join(home, 'orchestration.db'))
    const { runtime } = fixture.createRuntime(db, { checkHookAgentPresence: async () => 'live' })
    fixture.registerSecondPane(runtime)
    const coord = fixture.TERMINAL_HANDLE
    const worker = fixture.SECOND_TERMINAL_HANDLE
    const replacement = 'term_replacement'
    registerBoundPty(runtime, 'pty-replacement', fixture.WORKTREE_ID, null, {
      tabId: '55555555-5555-4555-8555-555555555555',
      leafId: '66666666-6666-4666-8666-666666666666',
      incarnationId: 'replacement-process'
    })
    runtime.registerPreAllocatedHandleForPty('pty-replacement', replacement)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: home })
    async function cli(handle: string, args: string[], exitCode = 0): Promise<unknown> {
      const output = await runProcess({
        program: process.execPath,
        args: [...cliEntryArgs, 'orchestration', ...args, '--json'],
        cwd: home,
        timeoutMs: 15_000,
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
        }
      })
      expect(output.timedOut, JSON.stringify({ args, ...output })).toBe(false)
      expect(output.code, JSON.stringify({ args, ...output })).toBe(exitCode)
      const response: unknown = JSON.parse(output.stdout)
      expect(response).toMatchObject({ ok: exitCode === 0 })
      return response
    }
    const refuseOwnership = (response: unknown) =>
      expect(response).toMatchObject({
        error: { code: 'run_ownership_required', data: { effectsApplied: false } }
      })
    try {
      await server.start()
      const root = idOf(await cli(coord, ['run-create', '--objective', 'Parent work']), 'run')
      const task = idOf(await cli(coord, ['task-create', '--spec', 'Delegated work']), 'task')
      const otherTask = idOf(await cli(coord, ['task-create', '--spec', 'Other work']), 'task')
      const attempt = idOf(
        await cli(coord, ['dispatch', '--task', task, '--to', worker]),
        'dispatch'
      )
      const child = idOf(
        await cli(worker, ['run-create', '--objective', 'Task-owned child']),
        'run'
      )
      const foreign = idOf(await cli(coord, ['run-create', '--objective', 'Separate work']), 'run')
      await cli(coord, ['run-use', '--id', root])
      expect(db.getRunRaw(foreign)?.coordinator_handle).toBeNull()
      const before = db.getRunRaw(foreign)
      refuseOwnership(await cli(worker, ['run-use', '--id', foreign], 1))
      expect(db.getRunRaw(foreign)).toEqual(before)
      expect(db.getRunRaw(child)?.coordinator_handle).toBe(worker)

      const grant = (taskId: string) =>
        cli(coord, ['run-handover', '--id', foreign, '--to-task', taskId])
      await grant(task)
      expect(getRunHandover(db, foreign)?.target_task_id).toBe(task)
      // Expire the saved grant without changing global clocks or subprocess time.
      db.db
        .prepare('UPDATE run_handovers SET expires_at = ? WHERE run_id = ?')
        .run(Date.now() - 1, foreign)
      refuseOwnership(await cli(worker, ['run-use', '--id', foreign], 1))
      await grant(task)
      await grant(otherTask)
      refuseOwnership(await cli(worker, ['run-use', '--id', foreign], 1))
      expect(getRunHandover(db, foreign)?.target_task_id).toBe(otherTask)
      await grant(task)
      expect(await cli(worker, ['run-use', '--id', foreign])).toMatchObject({
        result: { run: { id: foreign } }
      })
      expect(getRunHandover(db, foreign)).toBeUndefined()
      expect(getRunAuthority(db, foreign)?.owner_task_id).toBe(task)

      const childOrigin = getRunAuthority(db, child)
      await cli(worker, [
        'send',
        '--type',
        'worker_done',
        '--subject',
        'Replace this attempt',
        '--payload',
        JSON.stringify({ taskId: task, dispatchId: attempt, outcome: 'succeeded' })
      ])
      await cli(coord, ['task-update', '--id', task, '--status', 'ready'])
      await cli(coord, ['dispatch', '--task', task, '--to', replacement])
      expect(await cli(replacement, ['run-use', '--id', child])).toMatchObject({
        result: { run: { id: child } }
      })
      expect(getRunAuthority(db, child)).toMatchObject({
        creating_dispatch_id: childOrigin?.creating_dispatch_id,
        creating_task_id: task,
        owner_task_id: task
      })
      expect(await cli(replacement, ['run-use', '--id', foreign])).toMatchObject({
        result: { run: { id: foreign } }
      })
      // A superseded attempt must fail before its old ownership can authorize an unchanged seat.
      db.db.prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?").run(attempt)
      refuseOwnership(await cli(worker, ['run-use', '--id', child], 1))
      expect(db.getRunRaw(foreign)?.coordinator_handle).toBe(replacement)
    } finally {
      await server.stop()
      db.close()
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})
