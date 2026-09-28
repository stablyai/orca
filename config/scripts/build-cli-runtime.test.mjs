import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('./build-orcad-bun.mjs', () => ({ materializeRuntime: vi.fn() }))
vi.mock('./build-windows-conpty.mjs', () => ({ materializeWindowsConpty: vi.fn() }))
import { materializeRuntime } from './build-orcad-bun.mjs'
import { materializeWindowsConpty } from './build-windows-conpty.mjs'
import { buildCliRuntime } from './build-cli-runtime.mjs'
const roots = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.resetAllMocks()
})
describe('CLI runtime provider packaging', () => {
  it.each(['x64', 'arm64'])(
    'adds the pinned %s Windows provider beside the runtime',
    async (arch) => {
      const root = mkdtempSync(join(tmpdir(), 'cli-build-'))
      roots.push(root)
      vi.mocked(materializeRuntime).mockImplementation(async (_target, filename) =>
        writeFileSync(filename, 'runtime')
      )
      vi.mocked(materializeWindowsConpty).mockImplementation(async (_arch, directory) =>
        mkdirSync(directory)
      )
      await buildCliRuntime('win32', arch, root)
      const directory = join(root, 'out', 'cli-runtime', `win32-${arch}`)
      expect(materializeWindowsConpty).toHaveBeenCalledExactlyOnceWith(
        arch,
        join(directory, 'conpty')
      )
      expect(JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')).target).toBe(
        `win32-${arch}`
      )
    }
  )
  it.each(['darwin', 'linux'])('does not provision ConPTY for %s', async (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'cli-build-'))
    roots.push(root)
    await buildCliRuntime(platform, 'arm64', root)
    expect(materializeWindowsConpty).not.toHaveBeenCalled()
  })
})
