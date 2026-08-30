import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  clearWsFallbackPort,
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

  it('clears a persisted fallback port', () => {
    const userDataPath = makeUserDataPath()
    writeWsFallbackPort(userDataPath, 54321)
    clearWsFallbackPort(userDataPath)
    expect(existsSync(join(userDataPath, 'mobile-ws-fallback-port.json'))).toBe(false)
    expect(readWsFallbackPort(userDataPath)).toBeUndefined()
  })

  it('clearing is a no-op when nothing is persisted and survives an unremovable path', () => {
    const userDataPath = makeUserDataPath()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => clearWsFallbackPort(userDataPath)).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    // Why: a directory at the file's path makes rmSync throw — clearing is best-effort like the write, but
    // must leave a trace, since a silently kept file re-arms the flip-flop it was meant to end.
    mkdirSync(join(userDataPath, 'mobile-ws-fallback-port.json'))
    expect(() => clearWsFallbackPort(userDataPath)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
