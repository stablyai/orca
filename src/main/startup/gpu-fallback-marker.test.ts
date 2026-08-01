import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as DurableFileWrite from '../durable-file-write'
// Why vi.mock, not vi.spyOn: the named ESM import is inlined, so a spy on the
// module namespace never intercepts and the failure cases silently pass.
const durableWrite = vi.hoisted(() => ({ failWith: null as Error | null, calls: 0 }))
// Why a counter, not a spy: same inlining problem, and rmSync's own maxRetries
// applies only to recursive removals, so the hand-rolled retry needs proving.
const rmControl = vi.hoisted(() => ({ failuresLeft: 0, calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    rmSync: (path: Parameters<typeof actual.rmSync>[0], options?: object) => {
      rmControl.calls += 1
      if (rmControl.failuresLeft > 0) {
        rmControl.failuresLeft -= 1
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      return actual.rmSync(path, options)
    }
  }
})
vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  const fs = await import('node:fs')
  return {
    ...actual,
    writeFileDurableSync: (tmpPath: string, finalPath: string, payload: string) => {
      durableWrite.calls += 1
      if (durableWrite.failWith) {
        // Why write first: the real failure is renameSync, which leaves the temp
        // behind — throwing before it would leave the orphan cleanup uncovered.
        fs.writeFileSync(tmpPath, payload, 'utf-8')
        throw durableWrite.failWith
      }
      actual.writeFileDurableSync(tmpPath, finalPath, payload)
    }
  }
})
import {
  GPU_FALLBACK_MARKER_FILE,
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarker,
  sweepStaleGpuFallbackMarkerTempFiles,
  writeGpuFallbackMarker
} from './gpu-fallback-marker'

describe('gpu-fallback-marker', () => {
  let userDataPath: string
  const environment = {
    appVersion: '1.2.3',
    electronVersion: '42.3.3',
    platform: 'win32' as const
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-fallback-test-'))
    durableWrite.failWith = null
    durableWrite.calls = 0
    rmControl.failuresLeft = 0
    rmControl.calls = 0
  })

  afterEach(() => {
    durableWrite.failWith = null
    rmControl.failuresLeft = 0
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a written marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 123, crashesInWindow: 3 }, environment)
    expect(readGpuFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 2,
      engagedAt: 123,
      crashesInWindow: 3,
      appVersion: '1.2.3',
      electronVersion: '42.3.3',
      platform: 'win32'
    })
  })

  it('overwrites an existing marker and leaves no temp file behind', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, environment)
    writeGpuFallbackMarker(userDataPath, { engagedAt: 2, crashesInWindow: 5 }, environment)

    expect(readGpuFallbackMarker(userDataPath)?.engagedAt).toBe(2)
    // Why: the durable write renames through a temp file; an orphan would accumulate
    // on every GPU crash burst.
    expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('still writes the marker when the durable rename is refused', () => {
    // Why: Windows AV/indexer holds make renameSync EPERM where a direct write
    // lands. This path must never end up worse than a plain writeFileSync.
    durableWrite.failWith = Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })

    writeGpuFallbackMarker(userDataPath, { engagedAt: 7, crashesInWindow: 3 }, environment)

    // Why assert the call: an ineffective mock would leave this green while
    // covering nothing but the happy path.
    expect(durableWrite.calls).toBe(1)
    expect(readGpuFallbackMarker(userDataPath)?.engagedAt).toBe(7)
    expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('reports the durable-write cause when the direct fallback also fails', () => {
    const durableError = Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })
    durableWrite.failWith = durableError
    // A directory at the marker path makes the direct writeFileSync fail too.
    mkdirSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))

    // Why the durable error, not the fallback's: it names the real cause.
    expect(() =>
      writeGpuFallbackMarker(userDataPath, { engagedAt: 9, crashesInWindow: 3 }, environment)
    ).toThrow(durableError)
  })

  it('returns null when no marker exists', () => {
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
  })

  it('keeps an active marker for repeated launches on the same build', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const firstRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(firstRead?.crashesInWindow).toBe(4)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const secondRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(secondRead?.crashesInWindow).toBe(4)
  })

  it('clears an active marker when the app build changes', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        appVersion: '1.2.4'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears an active marker outside Windows', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        platform: 'linux'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: enableMainProcessGpuFeatures() is skipped while GPU fallback is active, and that function
  // carries the macOS disable-skia-graphite fix. A marker that survived on darwin would silently
  // strip the fix from the Macs it targets, so pin the platform gate for darwin specifically.
  it('clears an active marker on macOS so the Graphite fix is never skipped', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        platform: 'darwin'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a corrupt or wrong-version marker', () => {
    writeFileSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE), '{ not json')
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({ schemeVersion: 999, engagedAt: 1, crashesInWindow: 1 })
    )
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('sweeps temp files orphaned by a kill between write and rename', async () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, environment)
    // A foreign pid: the sweeper deliberately skips this process's own in-flight temps.
    const orphan = join(userDataPath, `${GPU_FALLBACK_MARKER_FILE}.999999.123.abc.tmp`)
    writeFileSync(orphan, '{}')

    await sweepStaleGpuFallbackMarkerTempFiles(userDataPath)

    expect(existsSync(orphan)).toBe(false)
    // The marker itself shares the prefix and must survive the sweep.
    expect(readGpuFallbackMarker(userDataPath)?.engagedAt).toBe(1)
  })

  it('retries a marker delete that is briefly refused', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, environment)
    rmControl.calls = 0
    rmControl.failuresLeft = 2

    expect(clearGpuFallbackMarker(userDataPath)).toBe(true)

    expect(rmControl.calls).toBe(3)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('reports a marker delete that never succeeds, after backing off', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, environment)
    rmControl.failuresLeft = Number.MAX_SAFE_INTEGER

    const startedAt = Date.now()
    expect(clearGpuFallbackMarker(userDataPath)).toBe(false)
    const elapsed = Date.now() - startedAt

    // Why the timing: a hot spin of 4 immediate unlinks satisfies the call count
    // identically but cannot outlast the AV hold the backoff exists for.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    rmControl.failuresLeft = 0
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)
  })

  it('never blocks startup revalidation on an undeletable marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, environment)
    rmControl.failuresLeft = Number.MAX_SAFE_INTEGER

    const startedAt = Date.now()
    // Version mismatch: the revalidation path that runs pre-window on every launch.
    expect(
      readActiveGpuFallbackMarker(userDataPath, { ...environment, appVersion: '9.9.9' })
    ).toBeNull()
    const elapsed = Date.now() - startedAt

    // Why: this runs before the window exists, so an AV hold must not add a
    // multi-hundred-millisecond stall for a delete the next launch redoes anyway.
    expect(elapsed).toBeLessThan(100)
    expect(rmControl.calls).toBe(1)
  })

  it('treats an already-gone marker as cleared even when the unlink errors', () => {
    // Why: a concurrent delete makes rmSync throw on a file that is already gone;
    // reporting that as a failure would keep the caller retrying forever.
    rmControl.failuresLeft = Number.MAX_SAFE_INTEGER

    expect(clearGpuFallbackMarker(userDataPath)).toBe(true)
    expect(rmControl.calls).toBe(1)
  })

  it('writes the marker before spending any time on the orphan temp', () => {
    durableWrite.failWith = Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })
    rmControl.failuresLeft = Number.MAX_SAFE_INTEGER

    const startedAt = Date.now()
    writeGpuFallbackMarker(userDataPath, { engagedAt: 5, crashesInWindow: 3 }, environment)
    const elapsed = Date.now() - startedAt

    expect(readGpuFallbackMarker(userDataPath)?.engagedAt).toBe(5)
    // Why: backing off on the temp before the write would push the marker past
    // the Chromium kill this whole path exists to survive.
    expect(elapsed).toBeLessThan(100)
  })

  it('can explicitly clear the marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    clearGpuFallbackMarker(userDataPath)
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
  })
})
