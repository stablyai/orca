import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncSystemCodexSessionsIntoManagedHomeIncrementally } from './codex-session-bridge'

const markerReads = vi.hoisted(() => ({ count: 0, transcriptStats: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    lstat: ((path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      if (String(path).endsWith('.jsonl')) {
        markerReads.transcriptStats += 1
      }
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.lstat,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).includes('.orca-session-copies')) {
        markerReads.count += 1
      }
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.readFile
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

function legacyCopy(day: string, index: number, bytes?: number): void {
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
      targetMtimeMs: copyStat.mtimeMs
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-copy-perf-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  mkdirSync(join(runtimeHome(), 'thread-writer-locks'), { recursive: true })
  markerReads.count = 0
  markerReads.transcriptStats = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('legacy session copy swap budget', () => {
  it.each([10, 100])('only protects markers after the read budget runs out (N=%i)', async (n) => {
    // Sorts first and is larger than one pass may read.
    legacyCopy('01', 0, 65 * 1024 * 1024)
    for (let index = 1; index <= n; index += 1) {
      legacyCopy('20', index)
    }

    await syncSystemCodexSessionsIntoManagedHomeIncrementally(
      { yieldMs: 0 },
      join(root, 'real-codex-home')
    )

    // One marker read per copy, as before this change; no copy past the budget is examined.
    expect(markerReads.count).toBe(n + 1)
    // Only the first copy is examined, whatever N is.
    expect(markerReads.transcriptStats).toBeLessThanOrEqual(6)
  })
})
