import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWindowsRelayConptyProvider } from './windows-relay-conpty-admission'

vi.mock('../shared/windows-conpty-release', async () => {
  const { createHash } = await import('node:crypto')
  return {
    WINDOWS_CONPTY_FILES: Object.fromEntries(
      ['x64', 'arm64'].map((arch) => [
        arch,
        Object.fromEntries(
          ['conpty.dll', 'OpenConsole.exe'].map((file) => [
            file,
            createHash('sha256').update(`${arch}/${file}`).digest('hex')
          ])
        )
      ])
    )
  }
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
const argv = process.argv
const roots: string[] = []
const daemon = { connectMode: false, cliMode: false }
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  process.argv = argv
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture(architecture = 'x64'): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-relay-conpty-'))
  roots.push(root)
  writeFileSync(join(root, 'relay.js'), '')
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    writeFileSync(join(root, file), `${architecture}/${file}`)
  }
  process.argv = [process.execPath, join(root, 'relay.js')]
  vi.stubEnv('BUN_CONPTY_LIBRARY', join(root, 'conpty.dll'))
  return root
}
describe('Windows relay provider admission', () => {
  it.each(['x64', 'arm64'])(
    'admits the adjacent qualified %s pair without changing the selector',
    (architecture) => {
      fixture(architecture)
      Object.defineProperty(process, 'arch', { value: architecture })
      const initial = process.env.BUN_CONPTY_LIBRARY
      expect(() => assertWindowsRelayConptyProvider(daemon)).not.toThrow()
      expect(process.env.BUN_CONPTY_LIBRARY).toBe(initial)
    }
  )
  it.each([undefined, '', 'relative/conpty.dll'])(
    'rejects absent or relative selector %s',
    (selector) => {
      fixture()
      vi.stubEnv('BUN_CONPTY_LIBRARY', selector)
      expect(() => assertWindowsRelayConptyProvider(daemon)).toThrow('before starting Bun')
    }
  )
  it('rejects a qualified provider from another installation', () => {
    const foreign = fixture()
    fixture()
    vi.stubEnv('BUN_CONPTY_LIBRARY', join(foreign, 'conpty.dll'))
    expect(() => assertWindowsRelayConptyProvider(daemon)).toThrow('this relay installation')
  })
  it.each(['conpty.dll', 'OpenConsole.exe'])('rejects corrupt and missing %s', (file) => {
    const root = fixture()
    writeFileSync(join(root, file), 'corrupt')
    expect(() => assertWindowsRelayConptyProvider(daemon)).toThrow('identity mismatch')
    rmSync(join(root, file))
    expect(() => assertWindowsRelayConptyProvider(daemon)).toThrow()
  })
  it('rejects the wrong architecture', () => {
    fixture('arm64')
    expect(() => assertWindowsRelayConptyProvider(daemon)).toThrow('identity mismatch')
  })
  it('does not gate reconnect, CLI bridging, or POSIX on a Windows provider', () => {
    vi.stubEnv('BUN_CONPTY_LIBRARY', undefined)
    expect(() => assertWindowsRelayConptyProvider({ ...daemon, connectMode: true })).not.toThrow()
    expect(() => assertWindowsRelayConptyProvider({ ...daemon, cliMode: true })).not.toThrow()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(() => assertWindowsRelayConptyProvider(daemon)).not.toThrow()
  })
})
