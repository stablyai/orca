import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mayUnaskedDaemonRunSessions } from './daemon-unlisted-session'

describe('daemons outside the inventory', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  function runtimeDir(pidFiles: Record<string, number>): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-unasked-daemon-'))
    dirs.push(dir)
    for (const [name, pid] of Object.entries(pidFiles)) {
      writeFileSync(join(dir, name), JSON.stringify({ pid }))
    }
    return dir
  }

  it('counts an older daemon that is still alive and no adapter asked', () => {
    const dir = runtimeDir({ 'daemon-v5.pid': process.pid })
    expect(mayUnaskedDaemonRunSessions(dir, new Set())).toBe(true)
    expect(mayUnaskedDaemonRunSessions(dir, new Set([5]))).toBe(false)
  })

  it('ignores pid files that name no live process or no older protocol', () => {
    expect(mayUnaskedDaemonRunSessions(runtimeDir({}), new Set())).toBe(false)
    expect(
      mayUnaskedDaemonRunSessions(runtimeDir({ 'daemon-vx.pid': process.pid }), new Set())
    ).toBe(false)
  })

  it('treats an unreadable runtime directory as possibly owned', () => {
    expect(mayUnaskedDaemonRunSessions(join(tmpdir(), 'orca-missing-runtime-dir'), new Set())).toBe(
      true
    )
    expect(mayUnaskedDaemonRunSessions(null, new Set())).toBe(true)
  })
})
