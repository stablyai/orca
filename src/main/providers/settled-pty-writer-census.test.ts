import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { WslDaemonPtyProvider } from '../wsl/wsl-daemon-pty-provider'
import { createUnavailablePtyProvider } from './unavailable-pty-provider'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const REPO_ROOT = join(__dirname, '..', '..', '..')

/**
 * Requiring the method is satisfiable by a lie: the degraded daemon router used to answer it
 * with `provider.write(...) !== false`, reproducing the fire-and-forget bug through the fix.
 * The census pins the producers and reads their bodies, so a new provider or a revived
 * fabricated handoff fails here rather than silently clearing a mailbox reservation.
 */
const SETTLED_PTY_WRITER_FILES = [
  'src/main/providers/relay-pty-provider.ts',
  'src/main/daemon/daemon-pty-router.ts',
  'src/main/daemon/daemon-pty-adapter.ts',
  'src/main/wsl/wsl-daemon-pty-provider.ts'
]

/** Where the provider-side settlement is actually decided; the adapter inherits its own. */
const SETTLED_WRITER_DECLARATIONS = [
  'src/main/providers/relay-pty-provider.ts',
  'src/main/providers/ssh-pty-provider-rpc-operations.ts',
  'src/main/daemon/daemon-pty-router.ts',
  'src/main/daemon/daemon-pty-session-input.ts',
  'src/main/wsl/wsl-daemon-pty-provider.ts',
  'src/main/providers/unavailable-pty-provider.ts'
]

function declaredProviderFiles(directory = join(REPO_ROOT, 'src/main')): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...declaredProviderFiles(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      if (/\bclass\s+\w+[^{}]*\bimplements\s+IPtyProvider\b/.test(readFileSync(path, 'utf8'))) {
        files.push(relative(REPO_ROOT, path).split('\\').join('/'))
      }
    }
  }
  return files.sort()
}

function settledWriterBody(file: string): string {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8')
  const start = source.indexOf('writeWithSettlement')
  expect(start, `${file} declares no settled writer`).toBeGreaterThan(-1)
  const end = source.indexOf('\n  }', start)
  return source.slice(start, end === -1 ? source.length : end)
}

describe('settled PTY writer census', () => {
  it('covers every production provider class that declares IPtyProvider', () => {
    expect(declaredProviderFiles()).toEqual([...SETTLED_PTY_WRITER_FILES].sort())
  })

  it('exposes a settled writer on every production provider instance', () => {
    const adapter = new DaemonPtyAdapter({
      socketPath: join(__dirname, 'census.sock'),
      tokenPath: join(__dirname, 'census.token')
    })
    const instances = [
      new SshPtyProvider('conn-census', createMockMux() as never),
      new DaemonPtyRouter({ current: adapter, legacy: [] }),
      adapter,
      new WslDaemonPtyProvider({ distro: 'Ubuntu', relayBuildId: 'census-build' }, adapter),
      createUnavailablePtyProvider()
    ]
    for (const provider of instances) {
      expect(typeof provider.writeWithSettlement, provider.constructor.name).toBe('function')
    }
  })

  it('never synthesizes a settlement from the fire-and-forget write', () => {
    for (const file of SETTLED_WRITER_DECLARATIONS) {
      expect(settledWriterBody(file), file).not.toMatch(/\.write\(/)
    }
  })
})
