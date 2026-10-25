import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearWsFallbackPort,
  readWsFallbackPort,
  wsFallbackPortLadder,
  writeWsFallbackPort
} from './ws-fallback-port-store'

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'ws-fallback-port-test-'))
}

describe('ws-fallback-port-store', () => {
  it('builds a deterministic ladder above the preferred port, none for an OS-assigned one', () => {
    // 6769 stays free for a `pnpm dev` instance pinned beside packaged Orca.
    expect(wsFallbackPortLadder(6768)).toEqual(Array.from({ length: 30 }, (_, i) => 6770 + i))
    expect(wsFallbackPortLadder(6769)).toEqual(Array.from({ length: 31 }, (_, i) => 6770 + i))
    expect(wsFallbackPortLadder(65530)).toEqual([65531, 65532, 65533, 65534, 65535])
    expect(wsFallbackPortLadder(0)).toEqual([])
  })

  it('clears a persisted fallback port', () => {
    const userDataPath = makeUserDataPath()
    writeWsFallbackPort(userDataPath, 54321)
    clearWsFallbackPort(userDataPath)
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
    expect(() => clearWsFallbackPort(userDataPath)).not.toThrow()
  })

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
})
