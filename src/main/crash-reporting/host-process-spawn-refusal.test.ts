import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DurableCrashBreadcrumb from './durable-crash-breadcrumb'

const { breadcrumbSinkThrows } = vi.hoisted(() => ({ breadcrumbSinkThrows: { value: false } }))

vi.mock('./durable-crash-breadcrumb', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableCrashBreadcrumb>()
  return {
    ...actual,
    recordCoalescedDurableCrashBreadcrumb: (
      input: Parameters<typeof actual.recordCoalescedDurableCrashBreadcrumb>[0]
    ): void => {
      if (breadcrumbSinkThrows.value) {
        throw new Error('trace sink exploded')
      }
      actual.recordCoalescedDurableCrashBreadcrumb(input)
    }
  }
})

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import {
  hostProcessSpawnRefusalDetails,
  hostSpawnRefusalMarker,
  noteHostProcessSpawnFailure,
  resetHostProcessSpawnRefusalForTest
} from './host-process-spawn-refusal'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'

function spawnError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields)
}

beforeEach(() => {
  breadcrumbSinkThrows.value = false
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
  clearCrashBreadcrumbsForTest()
  resetHostProcessSpawnRefusalForTest()
})

afterEach(() => {
  breadcrumbSinkThrows.value = false
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetHostProcessSpawnRefusalForTest()
})

describe('hostSpawnRefusalMarker', () => {
  it('names the refusal behind a failed spawn', () => {
    expect(
      hostSpawnRefusalMarker(
        spawnError('spawn UNKNOWN', { code: 'UNKNOWN', syscall: 'spawn git.exe' })
      )
    ).toBe('spawn-unknown')
    expect(
      hostSpawnRefusalMarker(spawnError('spawn EAGAIN', { code: 'EAGAIN', syscall: 'spawn git' }))
    ).toBe('fork-eagain')
    expect(
      hostSpawnRefusalMarker(spawnError('spawn ENOMEM', { code: 'ENOMEM', syscall: 'spawn git' }))
    ).toBe('not-enough-memory')
    expect(
      hostSpawnRefusalMarker(spawnError('spawn EMFILE', { code: 'EMFILE', syscall: 'spawn git' }))
    ).toBe('descriptors-exhausted')
  })

  it('leaves ordinary git failures alone', () => {
    expect(hostSpawnRefusalMarker(spawnError('git exited with 128.', { code: 128 }))).toBe(
      undefined
    )
    // A code without a spawn syscall behind it says nothing about the host.
    expect(hostSpawnRefusalMarker(spawnError('boom', { code: 'UNKNOWN' }))).toBe(undefined)
    expect(
      hostSpawnRefusalMarker(spawnError('ENOENT', { code: 'ENOENT', syscall: 'spawn git' }))
    ).toBe(undefined)
    expect(hostSpawnRefusalMarker(undefined)).toBe(undefined)
  })

  it('does not read a remote host out of a local child that spawned fine', () => {
    // execFile puts the child's whole stderr in the message, so a `remote:` line
    // relayed from a server used to be read as this machine running out of room.
    const relayed = spawnError(
      'Command failed: git push\nremote: ERROR_COMMITMENT_LIMIT on the server\n',
      { code: 128 }
    )

    expect(hostSpawnRefusalMarker(relayed)).toBe(undefined)

    noteHostProcessSpawnFailure('git', relayed)
    expect(hostProcessSpawnRefusalDetails(10_000)).toEqual({ hostProcessSpawnRefusedCount: 0 })
    expect(getCrashBreadcrumbSnapshot()).toEqual([])
  })
})

describe('noteHostProcessSpawnFailure', () => {
  it('spends one shared ring slot on a burst, not one per refusal', () => {
    const error = spawnError('spawn UNKNOWN', { code: 'UNKNOWN', syscall: 'spawn git.exe' })
    for (let index = 0; index < 6; index += 1) {
      noteHostProcessSpawnFailure('C:\\Program Files\\Git\\cmd\\git.exe', error, 1_000 + index)
    }

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'host_process_spawn_refused',
        data: expect.objectContaining({
          program: 'git.exe',
          marker: 'spawn-unknown',
          suppressedSinceLast: 5
        })
      })
    ])
  })

  it('reports the count and how long ago it last happened', () => {
    noteHostProcessSpawnFailure(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      spawnError('spawn ENOMEM', { code: 'ENOMEM', syscall: 'spawn git.exe' }),
      5_000
    )
    noteHostProcessSpawnFailure(
      '/usr/bin/git',
      spawnError('spawn EAGAIN', { code: 'EAGAIN', syscall: 'spawn git' }),
      6_000
    )

    expect(hostProcessSpawnRefusalDetails(10_000)).toEqual({
      hostProcessSpawnRefusedCount: 2,
      hostProcessSpawnRefusedLastAgeMs: 4_000,
      hostProcessSpawnRefusedMarkers: 'not-enough-memory, fork-eagain',
      hostProcessSpawnRefusedPrograms: 'git.exe, git'
    })
  })

  it('keeps counting past the ring it can show', () => {
    const error = spawnError('spawn ENOMEM', { code: 'ENOMEM', syscall: 'spawn git' })
    // 20 > the 16 tracked slots, so the first four programs are evicted from the ring
    // while the count keeps every refusal the session saw.
    for (let index = 0; index < 20; index += 1) {
      noteHostProcessSpawnFailure(index < 4 ? 'git.exe' : 'wsl.exe', error, 1_000 + index)
    }

    expect(hostProcessSpawnRefusalDetails(10_000)).toEqual({
      hostProcessSpawnRefusedCount: 20,
      hostProcessSpawnRefusedLastAgeMs: 8_981,
      hostProcessSpawnRefusedMarkers: 'not-enough-memory',
      hostProcessSpawnRefusedPrograms: 'wsl.exe'
    })
  })

  it('costs one ring slot across a refusal that outlives every coalesce window', () => {
    // Report a8b4e777's gap, on a host where every git spawn was being refused:
    // 17 minutes of once-a-second refusals is 34 coalesce windows. Coalescing
    // caps the rate at one new entry per window, not the total, so without a
    // retained slot those 34 windows fill the 30-entry ring and the pre-crash
    // clues - including the self_tree_kill this feature exists to age - are gone.
    let monotonicMs = 0
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs)
    const clues = [
      'self_tree_kill',
      'gpu_crashed',
      'renderer_memory',
      'window_hidden',
      'menu_built'
    ]
    for (const name of clues) {
      recordCrashBreadcrumb(name, { seeded: true })
    }
    const error = spawnError('spawn UNKNOWN', { code: 'UNKNOWN', syscall: 'spawn git.exe' })
    for (let second = 0; second < 17 * 60; second += 1) {
      monotonicMs = second * 1_000
      noteHostProcessSpawnFailure('git.exe', error, second * 1_000)
    }

    const snapshot = getCrashBreadcrumbSnapshot()

    expect(snapshot.filter((crumb) => crumb.name === 'host_process_spawn_refused')).toHaveLength(1)
    expect(
      snapshot.filter((crumb) => crumb.data?.seeded === true).map((crumb) => crumb.name)
    ).toEqual(clues)
    expect(hostProcessSpawnRefusalDetails(1_020_000).hostProcessSpawnRefusedCount).toBe(1_020)
  })

  it('spends its one slot on the newest refusal, not the first', () => {
    noteHostProcessSpawnFailure(
      'git.exe',
      spawnError('spawn ENOMEM', { code: 'ENOMEM', syscall: 'spawn git.exe' }),
      1_000
    )
    noteHostProcessSpawnFailure(
      'wsl.exe',
      spawnError('spawn UNKNOWN', { code: 'UNKNOWN', syscall: 'spawn wsl.exe' }),
      2_000
    )

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'host_process_spawn_refused',
        data: expect.objectContaining({ program: 'wsl.exe', marker: 'spawn-unknown' })
      })
    ])
  })

  it('says how many programs it had to leave out of the detail', () => {
    const error = spawnError('spawn EAGAIN', { code: 'EAGAIN', syscall: 'spawn git' })
    for (let index = 0; index < 12; index += 1) {
      noteHostProcessSpawnFailure(`refused-program-number-${index}.exe`, error, 1_000 + index)
    }

    expect(hostProcessSpawnRefusalDetails(2_000).hostProcessSpawnRefusedPrograms).toBe(
      'refused-program-number-0.exe, refused-program-number-1.exe, refused-program-number-2.exe, refused-program-number-3.exe, +8 more'
    )
  })

  it('does not let a failing breadcrumb sink escape into a child error listener', () => {
    breadcrumbSinkThrows.value = true

    expect(() =>
      noteHostProcessSpawnFailure(
        'git.exe',
        spawnError('spawn ENOMEM', { code: 'ENOMEM', syscall: 'spawn git.exe' }),
        1_000
      )
    ).not.toThrow()
    expect(hostProcessSpawnRefusalDetails(2_000)).toMatchObject({
      hostProcessSpawnRefusedCount: 1
    })
  })

  it('says so positively when the host was spawning fine', () => {
    noteHostProcessSpawnFailure('git', spawnError('git exited with 1.', { code: 1 }))

    expect(hostProcessSpawnRefusalDetails(10_000)).toEqual({
      hostProcessSpawnRefusedCount: 0
    })
    expect(getCrashBreadcrumbSnapshot()).toEqual([])
  })
})
