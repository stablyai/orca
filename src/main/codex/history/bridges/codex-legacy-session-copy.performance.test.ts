import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as ProcessHost from '@orca/process-host'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncSystemCodexSessionsIntoManagedHomeIncrementally } from './codex-session-bridge'

const markerReads = vi.hoisted(() => ({ count: 0, transcriptStats: 0, helpers: 0 }))

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return {
    ...actual,
    spawnProcess: (...args: Parameters<typeof actual.spawnProcess>) => {
      markerReads.helpers += 1
      return actual.spawnProcess(...args)
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]).endsWith('.jsonl')) {
        markerReads.transcriptStats += 1
      }
      return actual.lstat(...args)
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).includes('.orca-session-copies')) {
        markerReads.count += 1
      }
      return actual.readFile(...args)
    }
  }
})

let root: string

function runtimeHome(): string {
  return join(root, 'user-data', 'codex-runtime-home', 'home')
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function legacyCopy(day: string, index: number, bytes?: number, kept?: boolean): void {
  const id = `0199a1b2-c3d4-7e5f-8a9b-${index.toString(16).padStart(12, '0')}`
  const relative = join('2026', '05', day, `rollout-2026-05-${day}T10-00-00-${id}.jsonl`)
  const source = join(root, 'real-codex-home', 'sessions', relative)
  const copy = join(runtimeHome(), 'sessions', relative)
  writeFile(source, '{"turn":1}\n{"turn":2}\n')
  writeFile(copy, '{"turn":1}\n')
  if (bytes) {
    truncateSync(source, bytes)
    truncateSync(copy, bytes)
  }
  const sourceStat = lstatSync(source)
  const copyStat = lstatSync(copy)
  writeFile(
    join(runtimeHome(), '.orca-session-copies', `${relative}.json`),
    JSON.stringify({
      sourcePath: source,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      targetSize: copyStat.size,
      targetMtimeMs: copyStat.mtimeMs,
      ...(kept ? { targetSize: 1, kept: true } : {})
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-copy-perf-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  mkdirSync(join(runtimeHome(), 'thread-writer-locks'), { recursive: true })
  mkdirSync(join(root, 'real-codex-home', 'thread-writer-locks'), { recursive: true })
  markerReads.count = 0
  markerReads.transcriptStats = 0
  markerReads.helpers = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('legacy session copy swap budget', () => {
  it.each([10, 100])('only protects markers after the read budget runs out (N=%i)', async (n) => {
    // Each a third of what a pass may read (sparse): whichever comes second ends the pass.
    for (let index = 0; index < n + 2; index += 1) {
      legacyCopy('20', index, 33 * 1024 * 1024)
    }
    // Copies already settled as kept, written since they were copied.
    for (let index = 0; index < n; index += 1) {
      legacyCopy('20', n + 2 + index, undefined, true)
    }

    const pass = (): Promise<unknown> =>
      syncSystemCodexSessionsIntoManagedHomeIncrementally(
        { yieldMs: 0 },
        join(root, 'real-codex-home')
      )

    await pass()
    // One marker read per copy, as before this change; past the budget a copy is only stat'd once,
    // to protect its marker from older builds.
    expect(markerReads.count).toBe(2 * n + 2)
    expect(markerReads.transcriptStats).toBeLessThanOrEqual(n + 12)

    markerReads.transcriptStats = 0
    await pass()
    // Once protected, the copies past the budget aren't examined at all.
    expect(markerReads.transcriptStats).toBeLessThanOrEqual(12)
  })

  it.each([10, 100])('holds the locks with one helper for a whole pass (N=%i)', async (n) => {
    for (let index = 0; index < n; index += 1) {
      legacyCopy('20', index)
    }
    // A frozen clock never ends a hold window, so the count shows only what the pass shares.
    vi.useFakeTimers({ toFake: ['Date'] })

    await syncSystemCodexSessionsIntoManagedHomeIncrementally(
      { yieldMs: 0 },
      join(root, 'real-codex-home')
    )

    expect(markerReads.helpers).toBe(1)
  })
})
