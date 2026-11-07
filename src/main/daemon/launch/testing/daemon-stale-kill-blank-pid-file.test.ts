import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDaemonPidPath } from '../daemon-spawner'
import { killStaleDaemon } from '../daemon-stale-kill'
import { parseDaemonPidFile } from '../../endpoint/identity/daemon-pid-file-parse'

describe('killStaleDaemon with a blank pid record', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-blank-pid-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['empty', ''],
    ['whitespace', ' \n\t ']
  ])('removes an %s pid file so the next daemon can publish its own', async (_label, contents) => {
    const pidPath = getDaemonPidPath(dir)
    writeFileSync(pidPath, contents)

    const outcome = await killStaleDaemon(dir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => 'missing'
    })

    expect(outcome).toEqual({ killed: false, liveOwnerSurvived: false })
    expect(existsSync(pidPath)).toBe(false)
  })
})

describe('parseDaemonPidFile legacy integer records', () => {
  it.each(['', '   ', '0', '-12', '1.5', '1e3', '0x10', 'Infinity', '9007199254740993'])(
    'rejects %j',
    (contents) => {
      expect(parseDaemonPidFile(contents)).toBeNull()
    }
  )

  it('accepts a bare positive integer', () => {
    expect(parseDaemonPidFile('4242\n')?.pid).toBe(4242)
  })

  it.each([0, -1, 1.5])('rejects a JSON record with pid %j', (pid) => {
    expect(parseDaemonPidFile(JSON.stringify({ pid }))).toBeNull()
  })
})
