import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'
import {
  createClaudeChildTreeReaper as createClaudeChildTreeReaperImpl,
  proveClaudeChildExit,
  type ClaudeChildTreeReaper
} from './claude-agent-sdk-exit-proof'

// The descendant models an MCP server: it either cooperates or, when it traps
// SIGTERM, only a forced, verified sweep can reach it. The root either traps
// SIGTERM too, or leaves promptly on stdin end the way a healthy CLI does —
// which is the path that used to skip descendant proof entirely.
function childWithDescendantScript(input: {
  rootTrapsSigterm: boolean
  descendantTrapsSigterm: boolean
}): string {
  const descendantScript = `${input.descendantTrapsSigterm ? 'process.on("SIGTERM", () => {}); ' : ''}setInterval(() => {}, 1000000)`
  const rootBehaviour = input.rootTrapsSigterm
    ? `process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
setInterval(() => {}, 1000000)`
    : `process.stdin.on('end', () => process.exit(0))
process.stdin.resume()`
  return `
const descendant = require('node:child_process').spawn(
  process.execPath,
  ['-e', ${JSON.stringify(descendantScript)}],
  { stdio: 'ignore' }
)
descendant.unref()
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n')
${rootBehaviour}
`
}

const COOPERATIVE_CHILD = `
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.stdout.write('ready\\n')
`

/**
 * Sampled synchronously so it reads the exact moment the close boundary is
 * crossed. A zombie has exited (its parent just has not reaped it yet), so a
 * kill(pid, 0) probe would misreport it as running.
 */
function descendantState(pid: number): 'running' | 'exited' {
  let state: string
  try {
    state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
    }).trim()
  } catch (error) {
    // ps exits 1 when no process matches; anything else is a failed probe, not an answer.
    if ((error as { status?: number }).status !== 1) {
      throw error
    }
    return 'exited'
  }
  return state.startsWith('Z') ? 'exited' : 'running'
}

/**
 * ps lstart is second-resolution, so the identity-safe sweep only SIGKILLs a row
 * born strictly before the second the snapshot was captured in. The snapshot is
 * armed the moment close begins, so a descendant born in that same second can
 * only be asked, never forced — the same bound an MCP server spawned within a
 * second of the user closing the chat would hit.
 */
function ageDescendantPastTheCaptureSecond(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20))
}

/**
 * The close ladder as production drives it: `closeProcessRegistry` retries an
 * unproven close, and each retry re-verifies the retained snapshot. A loaded
 * host can spend one attempt's whole window inside `ps`, and reporting false
 * there is the honest verdict — the requirement is that TRUE never outruns the
 * observation, which the caller asserts at whichever boundary returns it.
 */
async function proveExitWithRetries(
  input: Parameters<typeof proveClaudeChildExit>[0],
  attempts = 3
): Promise<boolean> {
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (await proveClaudeChildExit(input)) {
      return true
    }
  }
  return proveClaudeChildExit(input)
}

function spawnScript(script: string): ReturnType<typeof spawnProcess> {
  return spawnProcess({
    program: process.execPath,
    args: ['-e', script],
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function firstStdoutLine(child: ReturnType<typeof spawnProcess>): Promise<string> {
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()))
  })
}

function observeExit(child: EventEmitter): { exitPromise: Promise<void>; exited: () => boolean } {
  let exited = false
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
  })
  return { exitPromise, exited: () => exited }
}

/** `null` models a spawn that failed before a pid existed. */
function mockChild(
  pid: number | null = 424242
): EventEmitter &
  Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'> & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter()
  return Object.assign(child, {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    kill: vi.fn(() => true)
  }) as never
}

/** A tree whose verdict is scripted per reap, recording when it was armed. */
function mockTree(verdicts: DescendantTreeVerdict[]): ClaudeChildTreeReaper & {
  capture: ReturnType<typeof vi.fn>
  reap: ReturnType<typeof vi.fn>
} {
  let treeVerdict: DescendantTreeVerdict = 'unverifiable'
  return {
    capture: vi.fn(async () => {}),
    reap: vi.fn(async () => {
      treeVerdict = verdicts.shift() ?? treeVerdict
      return treeVerdict
    }),
    get treeVerdict() {
      return treeVerdict
    }
  }
}

function windowsSnapshotOf(descendantPid: number): WindowsDescendantSnapshot {
  return {
    root: { pid: 424242, creationTimeMs: 1_700_000_000_001 },
    descendants: [{ pid: descendantPid, creationTimeMs: 1_700_000_000_000 }],
    unidentifiedCount: 0,
    capturedAtMs: 1
  }
}

function snapshotOf(descendantPid: number): DescendantSnapshot {
  return {
    root: { pid: 424242, startedAt: 'Mon Jan 1 00:00:00 2026' },
    rootPgid: 1,
    descendants: [
      { pid: descendantPid, ppid: 424242, pgid: 1, startedAt: 'Mon Jan 1 00:00:00 2026' }
    ],
    capturedAtMs: 1
  }
}

// Unit tests use synthetic process ids; production always supplies the fresh
// identity probe, so the harness explicitly models a matching probe.
function createClaudeChildTreeReaper(
  child: Parameters<typeof createClaudeChildTreeReaperImpl>[0],
  deps: Parameters<typeof createClaudeChildTreeReaperImpl>[1] = {}
): ReturnType<typeof createClaudeChildTreeReaperImpl> {
  return createClaudeChildTreeReaperImpl(child, {
    verifyRootIdentity: async () => true,
    ...deps
  })
}

describe('claude child exit proof', () => {
  it.runIf(process.platform !== 'win32')(
    'reports a proven exit only once a SIGTERM-resistant descendant is gone at the close boundary',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: true, descendantTrapsSigterm: true })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')
      await ageDescendantPastTheCaptureSecond()

      try {
        const proven = await proveExitWithRetries({ child, ...observeExit(child) })
        // Evaluated AT the boundary, not by polling until a deferred sweep timer
        // wins: true releases the lease, so a descendant still running here is
        // exactly the orphan the proof exists to prevent. False would be the
        // honest verdict for a tree that outlived the bounded ladder.
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        // Failure-safe only: the assertion above owns the requirement, this just
        // stops a failing run from leaking a process.
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it.runIf(process.platform !== 'win32')(
    'proves a promptly exiting root only once its stubborn descendant is gone too',
    async () => {
      // The ordinary healthy close: the root leaves on stdin end within the graceful
      // window. Its descendant must still be proven gone, not assumed gone with it.
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: false, descendantTrapsSigterm: true })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')
      await ageDescendantPastTheCaptureSecond()

      try {
        const proven = await proveExitWithRetries({ child, ...observeExit(child) })
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it.runIf(process.platform !== 'win32')(
    'still proves a stubborn child whose descendant honours SIGTERM',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: true, descendantTrapsSigterm: false })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      try {
        const proven = await proveExitWithRetries({ child, ...observeExit(child) })
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it('arms the snapshot before stdin closes and verifies it after a clean exit', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')
    const exit = observeExit(child)
    const tree = mockTree(['exited'])
    let exitedWhenArmed: boolean | null = null
    tree.capture.mockImplementation(async () => {
      exitedWhenArmed = exit.exited()
    })

    await expect(proveClaudeChildExit({ child, ...exit, tree })).resolves.toBe(true)
    // The snapshot is the only proof that survives the root: taken while it lived,
    // verified once it left. A reap before the exit would have been the forced ladder.
    expect(exitedWhenArmed).toBe(false)
    expect(tree.reap).toHaveBeenCalledTimes(1)
    expect(exit.exited()).toBe(true)
  }, 20_000)

  it('proves a clean close of a childless root with one snapshot and no signal', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')

    await expect(proveClaudeChildExit({ child, ...observeExit(child) })).resolves.toBe(true)
  }, 20_000)

  it('reports an unprovable exit as false rather than assuming the child died', async () => {
    const child = mockChild()
    const tree = mockTree(['exited'])

    await expect(
      proveClaudeChildExit({
        child,
        exitPromise: new Promise<void>(() => {}),
        exited: () => false,
        tree
      })
    ).resolves.toBe(false)
    expect(tree.reap).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('reports false when the root exit was observed but a descendant was seen alive', async () => {
    const child = mockChild()
    const exit = observeExit(child)
    const tree = mockTree(['live'])
    tree.reap.mockImplementation(async () => {
      child.emit('exit', null, 'SIGKILL')
      return 'live'
    })

    await expect(proveClaudeChildExit({ child, ...exit, tree })).resolves.toBe(false)
    expect(exit.exited()).toBe(true)
    // One verification per attempt: the retried close re-verifies, this one does not.
    expect(tree.reap).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('re-verifies an unproven tree on a retried close instead of trusting the dead root', async () => {
    const child = mockChild()
    const tree = mockTree(['exited'])

    await expect(
      proveClaudeChildExit({ child, exitPromise: Promise.resolve(), exited: () => true, tree })
    ).resolves.toBe(true)
    expect(tree.reap).toHaveBeenCalledTimes(1)
  })

  it('stays unproven for a root that left before any snapshot could be armed', async () => {
    const child = mockChild()
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const terminateDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'darwin',
      exited: () => true,
      captureDescendants,
      terminateDescendants
    })

    await expect(
      proveClaudeChildExit({ child, exitPromise: Promise.resolve(), exited: () => true, tree })
    ).resolves.toBe(false)
    // A dead root's descendants have reparented: walking its pid now could only
    // sweep a stranger, so no walk is attempted and nothing is proven.
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(terminateDescendants).not.toHaveBeenCalled()
    expect(tree.treeVerdict).toBe('unverifiable')
  })
})

describe('claude child tree reaper', () => {
  it('kills the root while verification runs and never stops it first', async () => {
    const child = mockChild()
    const release = Promise.withResolvers<DescendantTreeVerdict>()
    const terminateDescendants = vi.fn(() => release.promise)
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'darwin',
      captureDescendants,
      terminateDescendants
    })

    const first = tree.reap()
    const second = tree.reap()
    await vi.waitFor(() => expect(terminateDescendants).toHaveBeenCalledTimes(1))
    // A stopped root cannot verify: its killed children stay zombie rows in ps.
    expect(child.kill.mock.calls).toEqual([['SIGKILL']])
    expect(tree.treeVerdict).toBe('unverifiable')

    release.resolve('exited')
    await expect(Promise.all([first, second])).resolves.toEqual(['exited', 'exited'])
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    expect(tree.treeVerdict).toBe('exited')
  })

  it('re-verifies the retained snapshot on a later reap rather than re-walking a dead root', async () => {
    const child = mockChild()
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const terminateDescendants = vi
      .fn()
      .mockResolvedValueOnce('live')
      .mockResolvedValueOnce('exited')
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('live')
    expect(tree.treeVerdict).toBe('live')
    await expect(tree.reap()).resolves.toBe('exited')
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    expect(terminateDescendants).toHaveBeenNthCalledWith(2, snapshotOf(4243))
    expect(tree.treeVerdict).toBe('exited')
  })

  it('keeps an observed exit when a later re-read cannot see the table', async () => {
    const child = mockChild()
    const terminateDescendants = vi
      .fn()
      .mockResolvedValueOnce('exited')
      .mockResolvedValueOnce('unverifiable')
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants: vi.fn(async () => snapshotOf(4243)),
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('exited')
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(tree.treeVerdict).toBe('exited')
  })

  it('keeps an observed live descendant when a later re-read cannot see the table', async () => {
    const child = mockChild()
    // Reap #1 completed and saw a descendant alive at its deadline; the root then
    // left on its own and the re-verification on a loaded host could not read the
    // table. "Could not look" must not erase "was seen alive": the lease release
    // gate is exactly the pair this distinguishes.
    const terminateDescendants = vi
      .fn()
      .mockResolvedValueOnce('live')
      .mockResolvedValueOnce('unverifiable')
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants: vi.fn(async () => snapshotOf(4243)),
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('live')
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(tree.treeVerdict).toBe('live')
  })

  it('treats an unreadable process table as unproven and re-walks the live root', async () => {
    const child = mockChild()
    // A loaded host can miss the table's deadline; while the root still lives
    // that is a retryable read, not evidence that it has no descendants.
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshotOf(4243))
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateDescendants).not.toHaveBeenCalled()
    await expect(tree.reap()).resolves.toBe('exited')
    expect(captureDescendants).toHaveBeenCalledTimes(2)
  })

  it('does not latch a missing root while it is still live', async () => {
    const child = mockChild()
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce({ rootPgid: null, descendants: [], capturedAtMs: 1 })
      .mockResolvedValueOnce(snapshotOf(4243))
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await expect(tree.reap()).resolves.toBe('exited')
    expect(captureDescendants).toHaveBeenCalledTimes(2)
    expect(terminateDescendants).toHaveBeenCalledWith(snapshotOf(4243))
  })

  it('refreshes the live snapshot at close time so late descendants are included', async () => {
    const child = mockChild()
    const first = snapshotOf(4243)
    const second = {
      ...first,
      descendants: [...first.descendants, { ...first.descendants[0], pid: 4244 }]
    }
    const captureDescendants = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await tree.refresh?.()
    await tree.reap()

    expect(captureDescendants).toHaveBeenCalledTimes(2)
    expect(terminateDescendants).toHaveBeenCalledWith(second)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('keeps the original capture boundary for retained POSIX rows', async () => {
    const child = mockChild()
    const first = {
      ...snapshotOf(4243),
      capturedAtMs: 1_700_000_000_900
    }
    const refreshed = {
      ...first,
      capturedAtMs: 1_700_000_002_100,
      descendants: [
        ...first.descendants,
        {
          pid: 4244,
          ppid: 424242,
          pgid: 1,
          startedAt: 'Tue Jan 2 00:00:00 2026'
        }
      ]
    }
    const captureDescendants = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed)
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await tree.refresh?.()
    await tree.reap()

    expect(terminateDescendants).toHaveBeenCalledWith({
      ...refreshed,
      // The retained 4243 row was first observed in the earlier displayed
      // second. Its per-row boundary must not advance with the refresh.
      capturedAtMsByPid: {
        '4243': first.capturedAtMs,
        '4244': refreshed.capturedAtMs
      }
    })
  })

  it('fails closed when a POSIX refresh reuses a PID with a new identity', async () => {
    const child = mockChild()
    const first = snapshotOf(4243)
    const replacement = {
      ...first,
      descendants: [
        {
          ...first.descendants[0],
          pgid: 9,
          startedAt: 'Tue Jan 2 00:00:00 2026'
        }
      ]
    }
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await tree.refresh?.()

    await expect(tree.reap()).resolves.toBe('unverifiable')
    // The descendant evidence is discarded; the root's identity never was in doubt.
    expect(terminateDescendants).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('fails closed when a Windows refresh reuses a PID with a new creation time', async () => {
    const child = mockChild()
    const first = windowsSnapshotOf(4243)
    const replacement = {
      ...first,
      descendants: [{ pid: 4243, creationTimeMs: first.descendants[0].creationTimeMs + 1 }]
    }
    const captureWindowsDescendants = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
    const terminateWindowsTree = vi.fn(async () => {})
    const terminateWindowsDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants,
      terminateWindowsTree,
      terminateWindowsDescendants
    })

    await tree.capture()
    await tree.refresh?.()

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(terminateWindowsDescendants).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('queues a fresh boundary behind an output-triggered capture already in flight', async () => {
    const child = mockChild()
    const firstDone = Promise.withResolvers<void>()
    const first = snapshotOf(4243)
    const second = {
      ...first,
      descendants: [...first.descendants, { ...first.descendants[0], pid: 4244 }]
    }
    const captureDescendants = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstDone.promise
        return first
      })
      .mockResolvedValueOnce(second)
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    const outputCapture = tree.refresh!()
    await vi.waitFor(() => expect(captureDescendants).toHaveBeenCalledTimes(1))
    const closeCapture = tree.refresh!()
    await Promise.resolve()
    expect(captureDescendants).toHaveBeenCalledTimes(1)

    firstDone.resolve()
    await closeCapture
    await tree.reap()

    expect(captureDescendants).toHaveBeenCalledTimes(2)
    expect(terminateDescendants).toHaveBeenCalledWith(second)
    await outputCapture
  })

  it('retains a replacement descendant when the prior identity exited', async () => {
    const child = mockChild()
    const first = snapshotOf(4243)
    const replacement = snapshotOf(4244)
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement)
    const terminateDescendants = vi.fn(async (snapshot: DescendantSnapshot) =>
      snapshot.descendants.some((row) => row.pid === 4244) ? ('live' as const) : ('exited' as const)
    )
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await tree.refresh?.()
    await expect(tree.reap()).resolves.toBe('live')

    expect(terminateDescendants).toHaveBeenCalledWith({
      ...replacement,
      descendants: [...first.descendants, ...replacement.descendants]
    })
  })

  it('retains a Windows replacement descendant while preserving unidentified rows', async () => {
    const child = mockChild()
    const first = windowsSnapshotOf(4243)
    const replacement = {
      ...windowsSnapshotOf(4244),
      unidentifiedCount: 0
    }
    const captureWindowsDescendants = vi
      .fn()
      .mockResolvedValueOnce({ ...first, unidentifiedCount: 1 })
      .mockResolvedValueOnce(replacement)
    const terminateWindowsTree = vi.fn(async () => {})
    const terminateWindowsDescendants = vi.fn(async (snapshot: WindowsDescendantSnapshot) =>
      snapshot.descendants.some((row) => row.pid === 4244) ? ('live' as const) : ('exited' as const)
    )
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants,
      terminateWindowsTree,
      terminateWindowsDescendants
    })

    await tree.capture()
    await tree.refresh?.()
    await expect(tree.reap()).resolves.toBe('live')

    expect(terminateWindowsDescendants).toHaveBeenCalledWith({
      ...replacement,
      descendants: [...first.descendants, ...replacement.descendants],
      unidentifiedCount: 1
    })
  })

  it('retains the prior identity-safe snapshot when a refresh is partial', async () => {
    const child = mockChild()
    const first = {
      ...snapshotOf(4243),
      descendants: [
        ...snapshotOf(4243).descendants,
        { ...snapshotOf(4243).descendants[0], pid: 4244 }
      ]
    }
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        ...first,
        descendants: first.descendants.slice(0, 1)
      })
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await tree.capture()
    await tree.refresh?.()
    await tree.reap()

    expect(terminateDescendants).toHaveBeenCalledWith(first)
  })

  it('stops re-walking once the root is gone, however the table behaved', async () => {
    const child = mockChild()
    let exited = false
    const captureDescendants = vi.fn(async () => null)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => exited,
      captureDescendants,
      terminateDescendants: vi.fn()
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    // An unreadable table costs the snapshot, never the kill on the live root.
    expect(child.kill).toHaveBeenCalledTimes(1)
    exited = true
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    // The second attempt observes a dead root: Node has dropped the handle, so
    // there is nothing left to signal and no recycled pid to reach.
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('discards a walk that found no root instead of proving an empty tree', async () => {
    const child = mockChild()
    const captureDescendants = vi.fn(async () => ({
      rootPgid: null,
      descendants: [],
      capturedAtMs: 1
    }))
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants: vi.fn()
    })

    await tree.capture()
    await expect(tree.reap()).resolves.toBe('unverifiable')
    // A vacuous walk remains retryable while the root is live; no empty-tree
    // verdict is latched from a missing root row.
    expect(captureDescendants).toHaveBeenCalledTimes(2)
  })

  it('discards a walk that raced the root exit instead of proving an empty tree', async () => {
    const child = mockChild()
    let exited = false
    const captureDescendants = vi.fn(async () => {
      exited = true
      return { rootPgid: 1, descendants: [], capturedAtMs: 1 }
    })
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => exited,
      captureDescendants,
      terminateDescendants: vi.fn()
    })

    await tree.capture()
    await expect(tree.reap()).resolves.toBe('unverifiable')
  })

  it('proves a childless snapshot without signalling anything', async () => {
    const child = mockChild()
    const terminateDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants: vi.fn(async () => ({
        root: { pid: 424242, startedAt: 'Mon Jan 1 00:00:00 2026' },
        rootPgid: 1,
        descendants: [],
        capturedAtMs: 1
      })),
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('exited')
    expect(terminateDescendants).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('waits for the Windows tree kill before releasing the root', async () => {
    const child = mockChild()
    const release = Promise.withResolvers<void>()
    const terminateWindowsTree = vi.fn(() => release.promise)
    const captureDescendants = vi.fn()
    const terminateWindowsDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureDescendants,
      captureWindowsDescendants: vi.fn(async () => windowsSnapshotOf(4243)),
      terminateWindowsTree,
      terminateWindowsDescendants
    })

    const reap = tree.reap()
    await vi.waitFor(() =>
      expect(terminateWindowsTree).toHaveBeenCalledWith({
        pid: 424242,
        creationTimeMs: 1_700_000_000_001
      })
    )
    expect(child.kill).not.toHaveBeenCalled()
    expect(terminateWindowsDescendants).not.toHaveBeenCalled()
    release.resolve()
    await expect(reap).resolves.toBe('exited')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(terminateWindowsDescendants).toHaveBeenCalledWith(windowsSnapshotOf(4243))
    expect(captureDescendants).not.toHaveBeenCalled()
  })

  it('stays unproven on Windows when taskkill fails and a descendant is still observed', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants: vi.fn(async () => windowsSnapshotOf(4243)),
      terminateWindowsTree: vi.fn(async () => {
        throw new Error('taskkill: access denied')
      }),
      terminateWindowsDescendants: vi.fn(async () => 'live' as const)
    })

    // taskkill's own outcome is not the proof; the table read after it is.
    await expect(tree.reap()).resolves.toBe('live')
    expect(tree.treeVerdict).toBe('live')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('stays unproven on Windows when taskkill resolves but a descendant survives it', async () => {
    const child = mockChild()
    const terminateWindowsTree = vi.fn(async () => {})
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants: vi.fn(async () => windowsSnapshotOf(4243)),
      terminateWindowsTree,
      terminateWindowsDescendants: vi.fn(async () => 'live' as const)
    })

    await expect(tree.reap()).resolves.toBe('live')
    expect(terminateWindowsTree).toHaveBeenCalledTimes(1)
    expect(tree.treeVerdict).toBe('live')
  })

  it('never taskkills a Windows root that already exited, but still verifies its snapshot', async () => {
    const child = mockChild()
    let exited = false
    const terminateWindowsTree = vi.fn(async () => {})
    const terminateWindowsDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      exited: () => exited,
      captureWindowsDescendants: vi.fn(async () => windowsSnapshotOf(4243)),
      terminateWindowsTree,
      terminateWindowsDescendants
    })

    await tree.capture()
    exited = true
    await expect(tree.reap()).resolves.toBe('exited')
    // A dead root's pid may already belong to a stranger: taskkill /T /F on it
    // would take down an unrelated tree.
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(terminateWindowsDescendants).toHaveBeenCalledWith(windowsSnapshotOf(4243))
  })

  it('treats an unreadable Windows table as unproven', async () => {
    const child = mockChild()
    const terminateWindowsDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureWindowsDescendants: vi.fn(async () => null),
      terminateWindowsTree: vi.fn(async () => {}),
      terminateWindowsDescendants
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateWindowsDescendants).not.toHaveBeenCalled()
    // A host that cannot supply creation times blocks taskkill, not the root kill.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('has nothing to reap for a child that never spawned', async () => {
    const child = mockChild(null)
    const captureDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, { platform: 'linux', captureDescendants })

    await expect(tree.reap()).resolves.toBe('exited')
    expect(captureDescendants).not.toHaveBeenCalled()
  })
})
