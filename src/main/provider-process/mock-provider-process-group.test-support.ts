import { beforeEach, onTestFinished, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import * as processRows from './provider-process-row-read'
import * as descendants from '../pty-descendant-termination'
import * as managedProcesses from './managed-provider-process'
import * as ledger from './provider-process-ledger'

type ScriptedChild = Pick<PipedChildProcess, 'pid' | 'kill' | 'once' | 'emit'>
const children = new Map<number, { child: ScriptedChild; live: boolean; startedAt: string }>()

function registered(pid: number) {
  const entry = children.get(pid)
  if (!entry) {
    throw new Error('unregistered scripted process')
  }
  return entry
}

export function registerScriptedProviderChild<T extends ScriptedChild>(child: T): T {
  const pid = child.pid
  if (!pid || children.get(pid)?.live) {
    throw new Error('scripted child needs a unique live PID')
  }
  const entry = { child, live: true, startedAt: new Date().toISOString() }
  children.set(pid, entry)
  child.once('exit', () => {
    entry.live = false
  })
  return child
}

const read = processRows.readPosixProcessRow

beforeEach(() => {
  children.clear()
  const saved = getAppEnvironment()
  const directory = mkdtempSync(join(tmpdir(), 'pr31321-scripted-provider-'))
  setAppEnvironment({
    ...saved,
    getPath: (name) => (name === 'userData' ? directory : saved.getPath(name))
  })
  const managed = vi.spyOn(managedProcesses, 'spawnManagedProviderProcess')
  const recorded = vi.spyOn(ledger, 'recordProviderLaunch')
  vi.spyOn(processRows, 'readPosixProcessRow').mockImplementation(async (pid, ...args) => {
    if (pid === process.pid) {
      return read(pid, ...args)
    }
    const entry = registered(pid)
    return entry.live
      ? {
          pid,
          ppid: process.pid,
          pgid: pid,
          startedAt: entry.startedAt,
          startResolution: 'clock-tick'
        }
      : null
  })
  vi.spyOn(descendants, 'captureDescendantSnapshot').mockImplementation(async (pid) => {
    const entry = registered(pid)
    return { rootPgid: entry.live ? pid : null, descendants: [], capturedAtMs: Date.now() }
  })
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const entry = registered(Math.abs(pid))
    if (!entry.live) {
      throw Object.assign(new Error('scripted process exited'), { code: 'ESRCH' })
    }
    if (typeof signal === 'string' && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      throw new Error('unsupported scripted process signal')
    }
    if (signal !== 0) {
      entry.child.kill(signal)
      if (entry.live && signal === 'SIGKILL') {
        entry.child.emit('exit', null, signal)
        entry.child.emit('close', null, signal)
      }
    }
    return true
  })
  onTestFinished(async () => {
    try {
      for (const { child, live } of children.values()) {
        if (live) {
          process.kill(child.pid!, 'SIGKILL')
        }
      }
      if (vi.isFakeTimers()) {
        await vi.runAllTimersAsync()
      }
      vi.useRealTimers()
      for (const { value } of managed.mock.results.filter((result) => result.type === 'return')) {
        await value.close()
        await value.completion
      }
      for (const { value } of recorded.mock.results.filter((result) => result.type === 'return')) {
        await value.capture()
        await value.retire()
      }
    } finally {
      vi.restoreAllMocks()
      setAppEnvironment(saved)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
