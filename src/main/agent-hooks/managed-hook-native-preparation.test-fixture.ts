import { vi } from 'vitest'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import type * as WindowsProcesses from '../windows/windows-process-table'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'
import { readManagedHookProcessIdentity } from './managed-hook-owner-identity'
import type * as OwnerIdentity from './managed-hook-owner-identity'
import type * as LockRecords from './managed-hook-lock-records'
import type * as ChildProcess from 'node:child_process'
import { withClaudeSystemScope } from '../claude/statusline-ownership'

const trace = vi.hoisted(
  (): {
    phases: {
      phase: string
      started: number
      elapsed?: number
      terminal?: string
      code?: string | number
      signal?: string | null
      error?: string
      value?: string | number | null
    }[]
    pending: Set<Promise<unknown>>
    probes: number
    nativePlatform: NodeJS.Platform
  } => ({ phases: [], pending: new Set(), probes: 0, nativePlatform: process.platform })
)

function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const row: (typeof trace.phases)[number] = { phase: name, started: performance.now() }
  if (trace.phases.length < 64) {
    trace.phases.push(row)
  }
  const pending = (async () => {
    try {
      const result = await run()
      row.terminal =
        typeof result === 'string'
          ? result.startsWith('runtime:')
            ? 'runtime-fallback'
            : 'identity-string'
          : result === null
            ? 'null'
            : typeof result
      if (name.startsWith('probe:')) {
        row.code = 0
      }
      return result
    } catch (error) {
      row.terminal = 'rejected'
      row.error = error instanceof Error ? error.name : typeof error
      if (error instanceof Error) {
        if ('code' in error && (typeof error.code === 'number' || typeof error.code === 'string')) {
          row.code = error.code
        }
        if ('signal' in error && (typeof error.signal === 'string' || error.signal === null)) {
          row.signal = error.signal
        }
      }
      throw error
    } finally {
      row.elapsed = performance.now() - row.started
    }
  })()
  trace.pending.add(pending)
  void pending.then(
    () => trace.pending.delete(pending),
    () => trace.pending.delete(pending)
  )
  return pending
}

vi.mock('./managed-hook-owner-identity', async (original) => {
  const actual = await original<typeof OwnerIdentity>()
  return {
    ...actual,
    readManagedHookHostIdentity: () => phase('host', () => actual.readManagedHookHostIdentity()),
    readScopedWindowsSelfIdentity: () => {
      const started = performance.now()
      const value = actual.readScopedWindowsSelfIdentity()
      trace.phases.push({
        phase: 'scoped-self',
        started,
        elapsed: performance.now() - started,
        value,
        terminal: value.startsWith('runtime:') ? 'runtime-fallback' : 'native'
      })
      return value
    },
    readManagedHookProcessIdentity: (
      ...args: Parameters<typeof actual.readManagedHookProcessIdentity>
    ) =>
      phase(args[0] === process.pid ? 'self' : 'other-owner', () =>
        actual.readManagedHookProcessIdentity(...args)
      )
  }
})
vi.mock('../windows/windows-process-table', async (original) => {
  const actual = await original<typeof WindowsProcesses>()
  return {
    ...actual,
    readWindowsProcessCreationTime: (pid: number) => {
      const started = performance.now()
      const value = actual.readWindowsProcessCreationTime(pid)
      if (trace.phases.length < 64) {
        trace.phases.push({
          phase: `native-getter:${pid}`,
          started,
          elapsed: performance.now() - started,
          value,
          terminal: value === null ? 'unavailable' : 'native'
        })
      }
      return value
    }
  }
})
vi.mock('./managed-hook-lock-records', async (original) => {
  const actual = await original<typeof LockRecords>()
  return {
    ...actual,
    cleanupManagedHookLockFiles: (...args: Parameters<typeof actual.cleanupManagedHookLockFiles>) =>
      phase('shared-preparation-cleanup', () => actual.cleanupManagedHookLockFiles(...args))
  }
})
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  const actual = await original<typeof ChildProcess>()
  const asyncExec = promisify(actual.execFile)
  const execFile = vi.fn((...args: Parameters<typeof actual.execFile>) => {
    trace.probes++
    return actual.execFile(...args)
  })
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: Parameters<typeof asyncExec>) => {
      trace.probes++
      return phase(`probe:${args[0].split(/[\\/]/).pop()}`, () => asyncExec(...args))
    }
  })
  return { ...actual, execFile }
})

function snapshot() {
  return trace.phases.map((row) => ({
    ...row,
    pending: row.elapsed === undefined,
    elapsed: row.elapsed ?? performance.now() - row.started
  }))
}

export function resetNativePreparationTrace() {
  if (trace.pending.size) {
    throw new Error('Previous native preparation was not joined')
  }
  trace.phases = []
  trace.probes = 0
}

export async function diagnosticInstall<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const started = performance.now()
  const probes = trace.probes
  const report = (outcome: { result: T } | { error: string }) =>
    console.log(
      'NATIVE_HOOK_INSTALL',
      JSON.stringify({
        name,
        nativePlatform: trace.nativePlatform,
        platform: process.platform,
        elapsed: performance.now() - started,
        probes: trace.probes - probes,
        ...outcome,
        phases: snapshot()
      })
    )
  try {
    const result = await run()
    report({ result })
    return result
  } catch (error) {
    report({ error: String(error) })
    throw error
  }
}

export async function joinNativePreparation(home: string) {
  if (!trace.phases.length) {
    return
  }
  const started = performance.now()
  // These are the actual finite raw probes, including work abandoned by a 2s waiter.
  while (trace.pending.size) {
    await Promise.allSettled(trace.pending)
  }
  if (trace.nativePlatform === 'win32' && trace.phases.some((row) => row.phase === 'scoped-self')) {
    try {
      // This observation follows the original cold action and cannot turn its failure into a pass.
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', "process.send('ready'); process.on('message', () => process.exit(0))"],
        env: { ...process.env, HOME: home, USERPROFILE: home, ORCA_BACKGROUND_LAUNCH: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      const closed = once(child, 'close')
      try {
        await Promise.race([
          once(child, 'message'),
          closed.then(() => {
            throw new Error('Birth observer child exited before ready')
          })
        ])
        const rows: {
          pid: number
          native: number | null
          nativeMs: number
          legacy: string | null | undefined
          canonicalNative: string | null
          exact: boolean | null
        }[] = []
        for (const pid of [process.pid, child.pid!]) {
          const before = performance.now()
          const native = readWindowsProcessCreationTime(pid)
          const nativeMs = performance.now() - before
          const legacy = await readManagedHookProcessIdentity(pid)
          const compatible =
            typeof legacy === 'string' &&
            new RegExp(`^win32:${pid}:[1-9]\\d*$`).test(legacy) &&
            Number.isSafeInteger(Number(legacy.split(':')[2]))
          rows.push({
            pid,
            native,
            nativeMs,
            legacy,
            canonicalNative: native === null ? null : `win32:${pid}:${native}`,
            exact: compatible && native !== null ? legacy === `win32:${pid}:${native}` : null
          })
        }
        console.log('NATIVE_HOOK_BIRTH_COMPARISON', JSON.stringify(rows))
      } finally {
        if (child.connected) {
          child.send('shutdown')
        }
        await closed
      }
    } catch (error) {
      console.log('NATIVE_HOOK_BIRTH_COMPARISON_ERROR', String(error))
    }
  }
  const terminal = await diagnosticInstall(
    'subsequent-same-home-scope-after-raw-join',
    async () => {
      try {
        await withClaudeSystemScope(home, AbortSignal.timeout(2000), async () => {})
        return { state: 'settled' }
      } catch (error) {
        return { state: 'error', detail: String(error) }
      }
    }
  )
  while (trace.pending.size) {
    await Promise.allSettled(trace.pending)
  }
  console.log(
    'NATIVE_HOOK_TERMINAL',
    JSON.stringify({
      nativePlatform: trace.nativePlatform,
      platform: process.platform,
      elapsed: performance.now() - started,
      terminal,
      pendingRaw: trace.pending.size,
      phases: snapshot()
    })
  )
  resetNativePreparationTrace()
}
