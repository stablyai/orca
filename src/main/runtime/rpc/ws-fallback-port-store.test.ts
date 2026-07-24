import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_FALLBACK_PORT_FILE_BYTES,
  readWsFallbackPort,
  writeWsFallbackPort
} from './ws-fallback-port-store'

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'ws-fallback-port-test-'))
}

describe('ws-fallback-port-store', () => {
  it('round-trips a persisted fallback port', () => {
    const userDataPath = makeUserDataPath()
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
    writeWsFallbackPort(userDataPath, 54321)
    expect(readWsFallbackPort(userDataPath)).toBe(54321)
  })

  it('ignores corrupt or invalid contents', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(join(userDataPath, 'mobile-ws-fallback-port.json'), 'not json', 'utf8')
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
    writeFileSync(join(userDataPath, 'mobile-ws-fallback-port.json'), '{"port":-4}', 'utf8')
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
    writeFileSync(join(userDataPath, 'mobile-ws-fallback-port.json'), '{"port":"80"}', 'utf8')
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
  })

  it('refuses to persist an invalid port', () => {
    const userDataPath = makeUserDataPath()
    writeWsFallbackPort(userDataPath, 0)
    writeWsFallbackPort(userDataPath, 70000)
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
  })

  it('ignores an oversized sparse fallback-port file', () => {
    const userDataPath = makeUserDataPath()
    const path = join(userDataPath, 'mobile-ws-fallback-port.json')
    writeFileSync(path, '{"port":54321}', 'utf8')
    truncateSync(path, MAX_FALLBACK_PORT_FILE_BYTES + 1)

    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
  })
})
