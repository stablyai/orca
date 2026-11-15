import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnManagedProviderProcess } from './managed-provider-process'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))

const cleanups: (() => Promise<void>)[] = []
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-provider-outcome-'))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await rm(state.root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('native parent outcome loss', () => {
  it('retires a cleaned CLI group after parent SIGUSR1 with unknown CLI outcome', async () => {
    let parent: ChildProcess | undefined
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        cwd: state.root,
        args: [
          '-e',
          String.raw`
          const descendant = require('node:child_process').spawn(process.execPath, ['-e',
            "process.stdout.write('ready'); setInterval(() => {}, 60000)"
          ], { stdio: ['ignore', 'pipe', 'inherit'] })
          descendant.stdout.once('data', () => {
            process.stderr.write('retained stderr\n')
            process.stdout.write(JSON.stringify({
              leader: process.pid, parent: process.ppid, descendant: descendant.pid
            }) + '\n')
          })
          setInterval(() => {}, 60000)
        `
        ]
      },
      {
        site: 'native-parent-outcome-loss-test',
        inheritedEnv: process.env,
        spawnImpl: (spec) => {
          parent = spawnProcess(spec)
          return parent
        }
      }
    )
    const errors: Error[] = []
    const exits: unknown[] = []
    const managedExits: unknown[] = []
    managed.child.on('error', (error) => errors.push(error))
    managed.child.on('exit', (...status) => exits.push(status))
    managed.onExit((status) => managedExits.push(status))
    const closed = new Promise<unknown[]>((resolve) => {
      managed.child.once('close', (...status) => resolve(status))
    })
    cleanups.push(async () => {
      managed.child.kill('SIGKILL')
      await closed
    })
    const [chunk] = await once(managed.child.stdout, 'data')
    const identity = JSON.parse(chunk.toString())
    await managed.child.ready
    if (!parent?.pid) {
      throw new Error('Missing native parent')
    }
    const rawParent = parent
    expect(identity.parent).toBe(rawParent.pid)
    expect(identity.leader).toBe(managed.child.pid)
    expect(identity.leader).not.toBe(rawParent.pid)
    expect(() => process.kill(identity.leader, 0)).not.toThrow()
    expect(() => process.kill(identity.descendant, 0)).not.toThrow()
    const parentExited = new Promise<unknown[]>((resolve) => {
      rawParent.once('exit', (...status) => resolve(status))
    })
    rawParent.kill('SIGUSR1')
    await expect(parentExited).resolves.toEqual([null, 'SIGUSR1'])
    await expect(closed).resolves.toEqual([null, null])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0]).not.toHaveProperty('providerLaunchFailed')
    expect(exits).toEqual([[null, null]])
    expect(managedExits).toEqual([{ code: null, signal: null, processless: false }])
    expect(managed.child.exitCode).toBeNull()
    expect(managed.child.signalCode).toBeNull()
    expect(managed.child.leaderExited).toBe(true)
    expect(managed.exitStatus).toEqual({ code: null, signal: null, processless: false })
    expect(managed.rootExitObserved).toBe(true)
    expect(managed.rootVerdict).toBe('exited')
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    expect(managed.processless).toBe(false)
    expect(managed.child.killed).toBe(true)
    expect(managed.stderrTail()).toBe('retained stderr\n')
    for (const pid of [identity.leader, identity.descendant]) {
      const status = await runProcess({
        program: 'ps',
        args: ['-o', 'stat=', '-p', String(pid)],
        timeoutMs: 2_000
      })
      expect(status.timedOut).toBe(false)
      expect(status.code === 0 || status.code === 1).toBe(true)
      // A non-reaping init may retain a zombie after H dies; it is no longer running.
      expect(status.stdout.trim()).toMatch(/^(Z\S*)?$/)
    }
  })
})
