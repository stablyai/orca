import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWindowsConptyProvider } from './windows-conpty-provider'

vi.mock('../../shared/windows-conpty-release', async () => {
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
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(arch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-conpty-provider-'))
  roots.push(root)
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    writeFileSync(join(root, file), `${arch}/${file}`)
  }
  return root
}
describe('trusted Windows ConPTY provider', () => {
  it.each(['x64', 'arm64'])('selects only the pinned %s pair', (arch) => {
    const root = fixture(arch)
    expect(resolveWindowsConptyProvider(root, arch)).toBe(join(root, 'conpty.dll'))
    expect(() => resolveWindowsConptyProvider(root, arch === 'x64' ? 'arm64' : 'x64')).toThrow(
      'identity mismatch'
    )
  })
  it.each(['conpty.dll', 'OpenConsole.exe'])('rejects a missing or corrupt %s', (file) => {
    const root = fixture('x64')
    rmSync(join(root, file))
    expect(() => resolveWindowsConptyProvider(root, 'x64')).toThrow()
    writeFileSync(join(root, file), 'foreign bytes')
    expect(() => resolveWindowsConptyProvider(root, 'x64')).toThrow('identity mismatch')
  })
  it('rejects unknown architectures before opening files', () => {
    expect(() => resolveWindowsConptyProvider('/missing', 'ia32')).toThrow('Unsupported')
  })
})
