import { describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { executeCodexMaintenanceProcess } from './codex-maintenance-process'
import { setTimeout as scheduleTimeout } from 'node:timers'

function live(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('owned maintenance process supervision', () => {
  it.skipIf(process.platform === 'win32')(
    'reaps a helper retaining the pipes after timeout and settles within the stop budget',
    async () => {
      let output = ''
      const script = `
      const {spawn} = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('helper='+process.pid); setTimeout(()=>process.exit(0),30000)"], {stdio:'inherit'});
      process.on('SIGTERM',()=>process.exit(0));
      setTimeout(()=>process.exit(0),30000);
    `
      let triggerTimeout: () => void = () => {
        throw new Error('Timeout was not scheduled')
      }
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((callback, delay, ...args) => {
          if (delay === 30_000) {
            triggerTimeout = () => callback(...args)
          }
          return scheduleTimeout(callback, delay, ...args)
        })
      const pending = executeCodexMaintenanceProcess(
        { program: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH } },
        (chunk) => {
          output += chunk.toString()
        },
        { timeoutMs: 30_000 }
      )
      let started = 0
      try {
        await vi.waitFor(() => expect(output).toMatch(/helper=\d+/), { timeout: 15_000 })
      } finally {
        timer.mockRestore()
        started = Date.now()
        triggerTimeout()
        await pending
      }
      const result = await pending
      const pid = Number(output.match(/helper=(\d+)/)?.[1])
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      expect(live(pid)).toBe(false)
      expect(result.error).toContain('timed out')
      expect(result.termination).toBe('exited')
      expect(Date.now() - started).toBeLessThan(8_000)
    },
    25_000
  )

  it.skipIf(process.platform === 'win32')(
    'cleans helpers on ordinary root exit without waiting for their inherited pipes',
    async () => {
      let output = ''
      const script = `
      const {spawn} = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', "console.log('helper='+process.pid); process.send('ready'); setTimeout(()=>process.exit(0),30000)"], {stdio:['ignore','inherit','inherit','ipc']});
      helper.once('message',()=>process.exit(0));
      setTimeout(()=>process.exit(2),20000);
    `
      const result = await executeCodexMaintenanceProcess(
        { program: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH } },
        (chunk) => {
          output += chunk.toString()
        }
      )
      const pid = Number(output.match(/helper=(\d+)/)?.[1])
      expect(pid).toBeGreaterThan(0)
      expect(live(pid)).toBe(false)
      expect(result.code).toBe(0)
      expect(result.termination).toBe('exited')
    },
    25_000
  )

  it.skipIf(process.platform === 'win32')(
    'preserves an ambiguous supervisor failure as unverifiable',
    async () => {
      const result = await executeCodexMaintenanceProcess(
        { program: process.execPath, args: ['-e', 'process.exit(1)'] },
        () => {}
      )
      expect(result.code).toBe(1)
      expect(result.termination).toBe('unverifiable')
      expect(result.isLive()).toBe(false)
    }
  )

  it('reports failed tree termination as unverifiable and drains pipes within a bound', async () => {
    const children: PipedChildProcess[] = []
    const spawn: PipedProcessSpawner = (spec) => {
      // The Windows supervisor's system cwd does not exist on the POSIX test host.
      const child = spawnProcess(
        process.platform === 'win32' ? spec : { ...spec, cwd: process.cwd() }
      )
      children.push(child)
      return child
    }
    const stop = vi.fn(async () => false)
    try {
      const result = await executeCodexMaintenanceProcess(
        {
          program: process.execPath,
          args: ['-e', 'setTimeout(()=>process.exit(0),2500)'],
          env: { PATH: process.env.PATH }
        },
        () => {},
        { platform: 'win32', spawn, stop, timeoutMs: 20 }
      )
      expect(stop).toHaveBeenCalledOnce()
      expect(result.termination).toBe('unverifiable')
      expect(result.code).toBeNull()
      expect(result.error).toContain('unverifiable')
      expect(result.isLive()).toBe(true)
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
    }
  }, 5_000)
})
