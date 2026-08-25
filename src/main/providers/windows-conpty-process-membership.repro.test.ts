import { fork, type ForkOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as membership from './windows-conpty-process-membership'

const requireFromTest = createRequire(import.meta.url)

describe.runIf(process.platform === 'win32')('Windows ConPTY helper fanout reproduction', () => {
  it('creates no OS helpers for concurrent foreground reads', async () => {
    const fixturePath = requireFromTest.resolve('./fixtures/conpty-console-list-stall.cjs')
    const children: ReturnType<typeof fork>[] = []
    const exits: Promise<void>[] = []
    const spawns: Promise<void>[] = []
    const forkProcess = ((
      modulePath: string | URL,
      argsOrOptions?: readonly string[] | ForkOptions,
      options?: ForkOptions
    ) => {
      const child = Array.isArray(argsOrOptions)
        ? fork(modulePath, argsOrOptions, options)
        : fork(modulePath, argsOrOptions as ForkOptions | undefined)
      children.push(child)
      spawns.push(
        new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
      )
      exits.push(new Promise((resolve) => child.once('exit', () => resolve())))
      return child
    }) as typeof fork
    const deps = {
      forkProcess,
      resolveAgentPath: () => fixturePath,
      timeoutMs: 3_000
    }
    const reader = createReader(deps)

    try {
      const probes = Array.from({ length: 32 }, (_, index) => reader.read(4242 + index))
      await Promise.all(spawns)
      const liveChildren = children.filter((child) => {
        if (!child.pid || child.exitCode !== null) {
          return false
        }
        try {
          process.kill(child.pid, 0)
          return true
        } catch {
          return false
        }
      })

      console.log(
        JSON.stringify({
          parentPid: process.pid,
          executable: process.execPath,
          childPids: liveChildren.map(({ pid }) => pid),
          spawnargs: liveChildren[0]?.spawnargs,
          forkCount: children.length,
          osLiveProcessCount: liveChildren.length
        })
      )
      await Promise.all(probes)
      await Promise.all(exits)
      const liveAfterSettlement = children.filter((child) => {
        if (!child.pid) {
          return false
        }
        try {
          process.kill(child.pid, 0)
          return true
        } catch {
          return false
        }
      })
      console.log(JSON.stringify({ osLiveProcessCountAfterSettlement: liveAfterSettlement.length }))
      expect(children).toHaveLength(0)
      expect(liveChildren).toHaveLength(0)
      expect(liveAfterSettlement).toHaveLength(0)
    } finally {
      reader.dispose()
      for (const child of children) {
        child.kill()
      }
    }
  }, 10_000)
})

type Reader = {
  dispose(): void
  read(rootPid: number): Promise<ReadonlySet<number> | null>
}

type ReaderDeps = {
  forkProcess: typeof fork
  resolveAgentPath: () => string
  timeoutMs: number
}

function createReader(deps: ReaderDeps): Reader {
  if (process.env.ORCA_TEST_DISABLE_CONPTY_MEMBERSHIP_NO_FORK === '1') {
    return createUnboundedReader(deps)
  }
  const ReaderClass = Reflect.get(membership, 'WindowsConptyProcessMembershipReader') as
    | (new (deps: ReaderDeps) => Reader)
    | undefined
  if (ReaderClass) {
    return new ReaderClass(deps)
  }
  const baselineRead = membership.readWindowsConptyProcessIds as unknown as (
    rootPid: number,
    deps: ReaderDeps
  ) => Promise<ReadonlySet<number> | null>
  return {
    dispose() {},
    read: (rootPid) => baselineRead(rootPid, deps)
  }
}

function createUnboundedReader(deps: ReaderDeps): Reader {
  return {
    dispose() {},
    read(rootPid) {
      const child = deps.forkProcess(deps.resolveAgentPath(), [String(rootPid)], { silent: true })
      return new Promise((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeout)
          resolve(null)
        }
        const timeout = setTimeout(() => {
          child.kill()
          finish()
        }, deps.timeoutMs)
        child.once('error', finish)
        child.once('exit', finish)
      })
    }
  }
}
