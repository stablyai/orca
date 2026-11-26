import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mayUnaskedDaemonRunSessions } from './daemon-unlisted-session'

describe('daemons outside the inventory', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  function runtimeDir(pidFiles: Record<string, number | string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-unasked-daemon-'))
    dirs.push(dir)
    for (const [name, pid] of Object.entries(pidFiles)) {
      writeFileSync(join(dir, name), typeof pid === 'string' ? pid : JSON.stringify({ pid }))
    }
    return dir
  }

  it('counts an older daemon that is still alive and no adapter asked', async () => {
    const dir = runtimeDir({ 'daemon-v5.pid': process.pid })
    await expect(mayUnaskedDaemonRunSessions(dir, new Set())).resolves.toBe(true)
    await expect(mayUnaskedDaemonRunSessions(dir, new Set([5]))).resolves.toBe(false)
  })

  it('ignores pid files that name no live process or no older protocol', async () => {
    await expect(mayUnaskedDaemonRunSessions(runtimeDir({}), new Set())).resolves.toBe(false)
    await expect(
      mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-vx.pid': process.pid }), new Set())
    ).resolves.toBe(false)
  })

  it('reads a pid file naming a process that has exited as no daemon', async () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    await expect(
      mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': exited }), new Set())
    ).resolves.toBe(false)
  })

  it('treats an unparsable or unreadable pid file as a daemon that may still run', async () => {
    await expect(
      mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': 'not a pid record' }), new Set())
    ).resolves.toBe(true)
    const dir = runtimeDir({})
    // A directory where the pid file should be: reading it fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, 'daemon-v5.pid'))
    await expect(mayUnaskedDaemonRunSessions(dir, new Set())).resolves.toBe(true)
  })

  it('never probes a record whose pid is not a positive integer, and counts it as possibly running', async () => {
    const kill = vi.spyOn(process, 'kill')
    try {
      for (const pid of [-1, 0, 1.5]) {
        await expect(
          mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': pid }), new Set())
        ).resolves.toBe(true)
      }
      // Signal 0 to zero or a negative pid targets a process group; its ESRCH proves nothing.
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('never lets a torn record name a process by its integer prefix', async () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    const kill = vi.spyOn(process, 'kill')
    try {
      for (const torn of [`{"pid": ${exited}.5`, `{"pid": ${exited}e3,`, `{"pid": ${exited}`]) {
        await expect(
          mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': torn }), new Set())
        ).resolves.toBe(true)
      }
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('reads a bare record as a pid only when it is plain digits', async () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    const kill = vi.spyOn(process, 'kill')
    try {
      for (const bare of ['1e3', '0x10', `0${exited}`, `${exited}.0`]) {
        await expect(
          mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': bare }), new Set())
        ).resolves.toBe(true)
      }
      expect(kill).not.toHaveBeenCalled()
      await expect(
        mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v5.pid': `${exited}\n` }), new Set())
      ).resolves.toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  it('ignores a live pid file for the current protocol, which the inventory already asks', async () => {
    await expect(
      mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-v9999.pid': process.pid }), new Set())
    ).resolves.toBe(false)
  })

  it('treats an unreadable runtime directory as possibly owned', async () => {
    await expect(
      mayUnaskedDaemonRunSessions(join(tmpdir(), 'orca-missing-runtime-dir'), new Set())
    ).resolves.toBe(true)
    await expect(mayUnaskedDaemonRunSessions(null, new Set())).resolves.toBe(true)
  })
})
