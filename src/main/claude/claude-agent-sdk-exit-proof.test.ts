import { collectDescendantRows } from '../pty-descendant-termination'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import {
  createClaudeChildTreeReaper,
  proveClaudeChildExit,
  type ClaudeChildTreeReaper
} from './claude-agent-sdk-exit-proof'
import { managedChild } from './claude-child-exit-proof-fixture'
import { GRACEFUL_EXIT_MS } from './claude-child-exit-proof-ladder'

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

/** Sample at the close boundary; zombies count as exited even though kill(pid, 0) finds them. */
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

// ps start times have second precision; cross that boundary so the snapshot permits forced signals.
function ageDescendantPastTheCaptureSecond(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 20))
}

// Model registry retries: slow process-table reads may leave one close attempt unproven.
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

function spawnScript(script: string): PipedChildProcess {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', script],
    stdio: ['pipe', 'pipe', 'pipe']
  })
  managedChild(child)
  return child
}

function firstStdoutLine(child: PipedChildProcess): Promise<string> {
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()))
  })
}

function mockChild(pid: number | null = 424242) {
  return Object.assign(createFakePipedChild(), {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
}

function mockTree(
  verdicts: DescendantTreeVerdict[],
  forcedReapAttempted = false
): ClaudeChildTreeReaper & {
  capture: ReturnType<typeof vi.fn>
  reap: ReturnType<typeof vi.fn>
} {
  let treeVerdict: DescendantTreeVerdict = 'unverifiable'
  return {
    forcedReapAttempted,
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
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
        // Assert at lease release; polling afterward could conceal a surviving descendant.
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
    'proves a promptly exiting root only once its stubborn descendant is gone too',
    async () => {
      const child = spawnScript(
        childWithDescendantScript({ rootTrapsSigterm: false, descendantTrapsSigterm: true })
      )
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')
      await ageDescendantPastTheCaptureSecond()

      try {
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
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
        const proven = await proveExitWithRetries({ managed: managedChild(child) })
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
    const managed = managedChild(child)
    const tree = mockTree(['exited'])
    let exitedWhenArmed: boolean | null = null
    tree.capture.mockImplementation(async () => {
      exitedWhenArmed = managed.rootVerdict === 'exited'
    })

    // The fixture closes under POSIX rules; on Windows a self-exit after stdin end is the close.
    await expect(proveClaudeChildExit({ managed, tree })).resolves.toBe(true)
    expect(exitedWhenArmed).toBe(false)
    expect(tree.reap).toHaveBeenCalledTimes(1)
    expect(managed.rootVerdict).toBe('exited')
  }, 20_000)

  it('proves a clean close of a childless root with one snapshot and no signal', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')

    await expect(proveClaudeChildExit({ managed: managedChild(child) })).resolves.toBe(true)
  }, 20_000)

  it('reports an unprovable exit as false rather than assuming the child died', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const tree = mockTree(['exited'])
      const proof = proveClaudeChildExit({
        managed: managedChild(mockChild()),
        tree
      })
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(proof).resolves.toBe(false)
      expect(tree.reap).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)

  it('reports false when the root exit was observed but a descendant was seen alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const child = mockChild()
      const managed = managedChild(child)
      const tree = mockTree(['live'])
      tree.reap.mockImplementation(async () => {
        child.emit('exit', null, 'SIGKILL')
        return 'live'
      })
      const proof = proveClaudeChildExit({ managed, tree })
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(GRACEFUL_EXIT_MS)

      await expect(proof).resolves.toBe(false)
      expect(managed.rootVerdict).toBe('exited')
      expect(tree.reap).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)

  it('re-verifies an unproven tree on a retried close instead of trusting the dead root', async () => {
    const child = mockChild()
    const managed = managedChild(child)
    child.emit('exit', 0, null)
    const tree = mockTree(['exited'])

    await expect(proveClaudeChildExit({ managed, tree })).resolves.toBe(true)
    expect(tree.reap).toHaveBeenCalledTimes(1)
  })

  it('on Windows re-asks the tree on a retried close once a forced reap has run', async () => {
    const child = mockChild()
    const managed = managedChild(child, 'win32')
    child.emit('exit', 0, null)
    // The earlier close forced a reap whose taskkill failed; the root has since exited.
    const tree = mockTree(['unverifiable'], true)

    await expect(proveClaudeChildExit({ managed, tree })).resolves.toBe(false)
    expect(tree.reap).toHaveBeenCalledTimes(1)
  })

  it('stays unproven for a root that left before any snapshot could be armed', async () => {
    const child = mockChild()
    const managed = managedChild(child)
    child.emit('exit', 0, null)
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const terminateDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'darwin',
      exited: () => true,
      captureDescendants,
      terminateDescendants
    })

    await expect(proveClaudeChildExit({ managed, tree })).resolves.toBe(false)
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
      // A retained row must keep its original capture boundary.
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
    expect(terminateDescendants).not.toHaveBeenCalled()
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
    expect(child.kill).toHaveBeenCalledTimes(1)
    exited = true
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(captureDescendants).toHaveBeenCalledTimes(1)
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

  it('kills a held Windows root with one taskkill and never snapshots it', async () => {
    const child = mockChild()
    const release = Promise.withResolvers<boolean>()
    const terminateWindowsTree = vi.fn(() => release.promise)
    const captureDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureDescendants,
      terminateWindowsTree
    })

    await tree.capture()
    await tree.refresh?.()
    const reap = tree.reap()
    await vi.waitFor(() => expect(terminateWindowsTree).toHaveBeenCalledWith(424242))
    expect(child.kill).not.toHaveBeenCalled()
    release.resolve(true)
    await expect(reap).resolves.toBe('exited')
    expect(tree.killDelivered).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(captureDescendants).not.toHaveBeenCalled()
  })

  it('reports a Windows tree unverifiable when taskkill does not exit cleanly', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      terminateWindowsTree: vi.fn(async () => false)
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(tree.treeVerdict).toBe('unverifiable')
    expect(tree.killDelivered).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a Windows tree unverifiable when taskkill could not run', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      terminateWindowsTree: vi.fn(async () => {
        throw new Error('taskkill: spawn failed')
      })
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(tree.killDelivered).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('never taskkills a Windows root that already exited', async () => {
    const child = mockChild()
    const terminateWindowsTree = vi.fn(async () => true)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      exited: () => true,
      terminateWindowsTree
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('has nothing to reap for a child that never spawned', async () => {
    const child = mockChild(null)
    const captureDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, { platform: 'linux', captureDescendants })

    await expect(tree.reap()).resolves.toBe('exited')
    expect(captureDescendants).not.toHaveBeenCalled()
  })
})

it.each([true, false])(
  'retains shared reaper taskkill=%s when root cleanup throws',
  async (delivered) => {
    const child = mockChild()
    child.kill.mockImplementation(() => {
      throw new Error('held root cleanup failed')
    })
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      terminateWindowsTree: async () => delivered
    })
    await expect(tree.reap()).resolves.toBe(delivered ? 'exited' : 'unverifiable')
    expect(tree.killDelivered).toBe(delivered)
  }
)

it.each([10, 100])(
  'shares one fresh forced snapshot across %s rows and callers',
  async (population) => {
    const child = mockChild()
    const root = { pid: 424242, ppid: 1, pgid: 424242, startedAt: 'Mon Jan 1 00:00:00 2026' }
    const writer = { ...root, pid: 424243, ppid: root.pid, pgid: 424243 }
    const rows = [
      root,
      writer,
      ...Array.from({ length: population - 2 }, (_, index) => ({
        ...root,
        pid: 424244 + index,
        ppid: index === 0 ? root.pid : index % 2 ? writer.pid : 1,
        pgid: writer.pid
      }))
    ]
    const fresh = Promise.withResolvers<void>()
    const capture = vi.fn(async () =>
      collectDescendantRows(
        root.pid,
        rows.filter((row) => row !== writer),
        1
      )
    )
    const terminate = vi.fn(async () => 'unverifiable' as const)
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const tree = createClaudeChildTreeReaper(child, {
        platform: 'linux',
        supervised: true,
        exited: () => false,
        captureDescendants: capture,
        terminateDescendants: terminate
      })
      await tree.capture()
      capture.mockImplementation(async () => {
        expect(child.kill).toHaveBeenCalledWith('SIGSTOP')
        await fresh.promise
        return collectDescendantRows(root.pid, rows, 2)
      })
      const first = tree.reap()
      for (let index = 0; index < population; index++) {
        expect(tree.reap()).toBe(first)
      }
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2))
      fresh.resolve()
      await first
      expect(capture).toHaveBeenCalledTimes(2)
      expect(terminate).toHaveBeenCalledOnce()
      expect(signal.mock.calls.length).toBeGreaterThan(0)
      expect(signal.mock.calls.length).toBeLessThanOrEqual(2)
      expect(
        signal.mock.calls.every(([pid, sig]) => pid === -writer.pid && sig === 'SIGKILL')
      ).toBe(true)
      expect(tree.killDelivered).toBe(true)
    } finally {
      signal.mockRestore()
    }
  }
)
