import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  DAP_ADAPTERS,
  probeDebugpy,
  resolveDebugAdapter
} from '../../../debug/dap-adapter-registry'
import { debugService } from '../../../debug/debug-service'
import { normalizeDebugPath } from '../../../debug/debug-breakpoint-store'
import { resolveLaunchSpec } from '../../../debug/launch-config'
import type { DebugSettings } from '../../../../shared/debug-settings-types'
import type { DebugSnapshot } from '../../../../preload/api/debug-api'
import type * as RunProcess from '@orca/process-host'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { DEBUG_METHODS } from './debug-methods'

// Pass-through spy: proves whether an adapter process was spawned at all.
const spawned = vi.hoisted(() => ({ programs: [] as string[] }))
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  return {
    ...actual,
    spawnProcess: (spec: Parameters<typeof actual.spawnProcess>[0]) => {
      spawned.programs.push(spec.program)
      return actual.spawnProcess(spec)
    }
  }
})

const PYTHON = process.env.ORCA_DEBUG_LIVE_PYTHON
const ROOT = normalizeDebugPath(join(__dirname, '__fixtures__'))
const TARGET = join(ROOT, 'agent_debug_target.py')
const RELATIVE_TARGET = 'agent_debug_target.py'
const REPO_ID = 'repo-live'
const SELECTOR = 'live'
const LIVE_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = LIVE_TIMEOUT_MS / 3
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

/** Whether to run; set but unusable FAILS here instead of skipping. */
async function livePython(skip: () => void): Promise<string | null> {
  if (!PYTHON) {
    console.warn(
      '[debug] skipping the live debug.* test: set ORCA_DEBUG_LIVE_PYTHON to a python with debugpy'
    )
    skip()
    return null
  }
  expect(existsSync(PYTHON), `ORCA_DEBUG_LIVE_PYTHON=${PYTHON} does not exist`).toBe(true)
  const row = DAP_ADAPTERS.find((r) => r.id === 'debugpy')
  const adapter = row && (await resolveDebugAdapter(row, { settings: settingsFor(PYTHON) }))
  expect(adapter?.ok, `no debugpy adapter for ORCA_DEBUG_LIVE_PYTHON=${PYTHON}`).toBe(true)
  const approvalKey = adapter?.ok ? adapter.approvalKey : ''
  const probe = await probeDebugpy(PYTHON, {
    approvalKey,
    approvedKeys: [approvalKey]
  })
  expect(probe, `ORCA_DEBUG_LIVE_PYTHON=${PYTHON} cannot import debugpy`).toEqual({ ok: true })
  return PYTHON
}

function settingsFor(python: string): DebugSettings {
  return {
    debugEnabledRepos: [REPO_ID],
    debugAdapterApprovals: {},
    debugPythonPath: python,
    debugJsDebugServerPath: '',
    debugLaunchApprovals: {}
  }
}

/** Configures the real debugService the way a person who approved this launch leaves it. */
async function configureService(python: string, approveLaunch: boolean) {
  const settings = settingsFor(python)
  const resolved = await resolveLaunchSpec({
    worktreePath: ROOT,
    filePath: TARGET,
    adapterOptions: { settings }
  })
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  const row = DAP_ADAPTERS.find((r) => r.id === resolved.spec.adapterId)
  const adapter = row && (await resolveDebugAdapter(row, { settings }))
  if (!adapter?.ok) {
    throw new Error(`no debugpy adapter for ${python}`)
  }
  settings.debugAdapterApprovals = { [REPO_ID]: [adapter.approvalKey] }
  settings.debugLaunchApprovals = {
    [REPO_ID]: approveLaunch ? [resolved.spec.configHash] : []
  }
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-live-debug-methods-'))
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  debugService.configure({
    getSettings: () => settings,
    getRepo: (id) =>
      id === REPO_ID
        ? { id, path: ROOT, displayName: 'live', badgeColor: '', addedAt: 0 }
        : undefined,
    listRepoRoots: async () => [ROOT],
    updateSettings: (updates) => Object.assign(settings, updates),
    userDataPath,
    // Never handed to the RPC path, so nothing here can mint a HumanConfirmation.
    humanKey: Symbol('live test human')
  })
  cleanups.push(() => debugService.dispose())
  return { binaryPath: adapter.binaryPath }
}

const runtime = {
  getRuntimeId: () => 'live-runtime',
  showManagedWorktree: async () => ({
    id: `${REPO_ID}::${ROOT}`,
    repoId: REPO_ID,
    path: ROOT
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: debug.* methods read only showManagedWorktree from the runtime.
} as unknown as OrcaRuntimeService
const dispatcher = new RpcDispatcher({ runtime, methods: DEBUG_METHODS })

/** One debug.* call, exactly as the CLI sends it; returns the DebugResult value or throws. */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const answer = await callRaw(method, params)
  if (!answer.ok) {
    throw new Error(`${method} refused: ${answer.reason} ${answer.message}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the value type the method's handler returns.
  return answer.value as T
}

type Answer = { ok: true; value: unknown } | { ok: false; reason: string; message: string }

async function callRaw(method: string, params: Record<string, unknown>): Promise<Answer> {
  const request: RpcRequest = {
    id: method,
    authToken: 'tok',
    method,
    params: { worktree: SELECTOR, ...params }
  }
  const response = await dispatcher.dispatch(request)
  if (!response.ok) {
    throw new Error(`${method} rpc error: ${response.error.code} ${response.error.message}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every debug.* handler returns a DebugResult.
  return response.result as Answer
}

/** As an agent chains `debug status` / `debug wait`: the state may already have arrived. */
async function settle(
  wanted: 'stopped' | 'terminated',
  done: (s: DebugSnapshot) => boolean
): Promise<DebugSnapshot> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  for (;;) {
    const snapshot = await call<DebugSnapshot>('debug.status')
    if (done(snapshot)) {
      return snapshot
    }
    if (Date.now() > deadline) {
      throw new Error(`never reached ${wanted}: ${JSON.stringify(snapshot)}`)
    }
    await call('debug.wait', { for: wanted, timeoutMs: 1_000 })
  }
}

type Frame = { id: number; line: number; source?: { path?: string } }
type Variable = { name: string; value: string }

describe('debug.* methods against real debugpy', () => {
  it(
    'an agent breaks, inspects, evaluates, steps and runs a Python program to the end',
    async (ctx) => {
      const python = await livePython(() => ctx.skip())
      if (!python) {
        return
      }
      const { binaryPath } = await configureService(python, true)
      const lines = readFileSync(TARGET, 'utf8').split('\n')
      const bpLine = lines.findIndex((line) => line.includes('total = subtotal + tax')) + 1
      expect(bpLine).toBeGreaterThan(0)

      const bp = await call<{ line: number }>('debug.breakpoints.set', {
        path: RELATIVE_TARGET,
        line: bpLine
      })
      expect(bp.line).toBe(bpLine)
      const started = await call<DebugSnapshot>('debug.start', {
        file: RELATIVE_TARGET
      })
      expect(started.adapterId).toBe('debugpy')
      expect(spawned.programs).toContain(binaryPath)

      const stopped = await settle('stopped', (s) => s.status === 'stopped')
      expect(stopped.stopped?.reason).toBe('breakpoint')
      const stack = await call<{ stackFrames: Frame[] }>('debug.stack')
      expect(stack.stackFrames[0].line).toBe(bpLine)
      expect(normalizeDebugPath(stack.stackFrames[0].source?.path ?? '')).toBe(TARGET)

      const locals = await call<{ variables: Variable[] }>('debug.variables')
      const value = (name: string) => locals.variables.find((v) => v.name === name)?.value
      expect(value('subtotal'), JSON.stringify(locals)).toBe('40')
      expect(value('tax'), JSON.stringify(locals)).toBe('2')
      const evaluated = await call<{ result: string }>('debug.evaluate', {
        expression: 'subtotal * 2'
      })
      expect(evaluated.result).toBe('80')

      await call('debug.next')
      await settle('stopped', (s) => s.status === 'stopped')
      const stepped = await call<{ stackFrames: Frame[] }>('debug.stack')
      expect(stepped.stackFrames[0].line).toBe(bpLine + 1)

      await call('debug.continue')
      const ended = await settle('terminated', (s) => s.status === 'terminated')
      expect(ended.lastError).toBeNull()
    },
    LIVE_TIMEOUT_MS
  )

  it(
    'wait after start or continue catches a stop that landed before wait was called, with no status poll',
    async (ctx) => {
      const python = await livePython(() => ctx.skip())
      if (!python) {
        return
      }
      await configureService(python, true)
      const lines = readFileSync(TARGET, 'utf8').split('\n')
      const bpLine = lines.findIndex((line) => line.includes('total = subtotal + tax')) + 1
      for (const line of [bpLine, bpLine + 1]) {
        await call('debug.breakpoints.set', { path: RELATIVE_TARGET, line })
      }
      // The pause guarantees each stop beats the wait: the race `continue && wait` used to lose.
      const late = () => new Promise((resolve) => setTimeout(resolve, 1_500))
      type Waited = { timedOut: boolean; snapshot: DebugSnapshot }
      const topLine = async () =>
        (await call<{ stackFrames: Frame[] }>('debug.stack')).stackFrames[0].line

      const started = await call<{ controlSeq: number }>('debug.start', {
        file: RELATIVE_TARGET
      })
      expect(typeof started.controlSeq).toBe('number')
      await late()
      const first = await call<Waited>('debug.wait', { for: 'stopped', timeoutMs: 5_000 })
      expect(first.timedOut).toBe(false)
      expect(first.snapshot.stopped?.reason).toBe('breakpoint')
      expect(await topLine()).toBe(bpLine)

      const resumed = await call<{ controlSeq: number }>('debug.continue')
      expect(resumed.controlSeq).toBeGreaterThan(started.controlSeq)
      await late()
      const second = await call<Waited>('debug.wait', { for: 'stopped', timeoutMs: 5_000 })
      expect(second.timedOut).toBe(false)
      expect(await topLine()).toBe(bpLine + 1)

      await call('debug.continue')
      await late()
      const ended = await call<Waited>('debug.wait', { for: 'terminated', timeoutMs: 5_000 })
      expect(ended.timedOut).toBe(false)
      expect(ended.snapshot.status).toBe('terminated')
    },
    LIVE_TIMEOUT_MS
  )

  it(
    'refuses a start whose launch was never approved, before any adapter is spawned',
    async (ctx) => {
      const python = await livePython(() => ctx.skip())
      if (!python) {
        return
      }
      const { binaryPath } = await configureService(python, false)
      const before = spawned.programs.length

      const answer = await callRaw('debug.start', { file: RELATIVE_TARGET })
      expect(answer.ok).toBe(false)
      expect(answer.ok ? null : answer.reason).toBe('launch-not-approved')
      expect(answer.ok ? '' : answer.message).toMatch(/never approved/)

      expect(spawned.programs.slice(before)).not.toContain(binaryPath)
      expect(spawned.programs.length).toBe(before)
      expect((await call<DebugSnapshot>('debug.status')).status).toBe('idle')
    },
    LIVE_TIMEOUT_MS
  )
})
