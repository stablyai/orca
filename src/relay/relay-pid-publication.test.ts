import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_PID_FILENAME, RELAY_VERSION_FILENAME } from '../shared/relay-artifacts'
import { publishRelayPid } from './relay-pid-publication'

describe('publishRelayPid', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  function versionDir(installed: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'relay-pid-'))
    directories.push(dir)
    writeFileSync(join(dir, 'relay.js'), '')
    if (installed) {
      writeFileSync(join(dir, RELAY_VERSION_FILENAME), '0.1.0+abc\n')
    }
    return dir
  }

  it('records the daemon PID beside an installed relay.js', () => {
    const dir = versionDir(true)
    publishRelayPid(join(dir, 'relay.js'))
    expect(readFileSync(join(dir, RELAY_PID_FILENAME), 'utf8')).toBe(`${process.pid}\n`)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves a build dir without .version untouched', () => {
    const dir = versionDir(false)
    publishRelayPid(join(dir, 'relay.js'))
    expect(existsSync(join(dir, RELAY_PID_FILENAME))).toBe(false)
  })

  it('does not throw when the entry cannot be resolved', () => {
    expect(() => publishRelayPid(join(tmpdir(), 'missing-relay-dir', 'relay.js'))).not.toThrow()
  })
})
