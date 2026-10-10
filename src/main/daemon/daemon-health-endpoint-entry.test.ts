import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killStaleDaemon } from './daemon-stale-kill'

describe.skipIf(process.platform === 'win32')('killStaleDaemon endpoint entries', () => {
  let dir: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-entry-'))
    socketPath = join(dir, 'daemon.sock')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a regular file for the publishing daemon to replace', async () => {
    writeFileSync(socketPath, 'not a socket')

    await expect(killStaleDaemon(dir, socketPath, join(dir, 'daemon.token'))).resolves.toEqual({
      killed: false,
      liveOwnerSurvived: false
    })
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket')
  })

  it('leaves a dangling symlink for the publishing daemon to replace', async () => {
    symlinkSync(join(dir, 'missing-target'), socketPath)

    await expect(killStaleDaemon(dir, socketPath, join(dir, 'daemon.token'))).resolves.toEqual({
      killed: false,
      liveOwnerSurvived: false
    })
    expect(lstatSync(socketPath).isSymbolicLink()).toBe(true)
  })
})
