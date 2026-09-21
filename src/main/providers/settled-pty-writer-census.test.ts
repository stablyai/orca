import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider } from './local-pty-provider'
import { SshPtyProvider } from './ssh-pty-provider'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
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
  'src/main/providers/local-pty-provider.ts',
  'src/main/providers/ssh-pty-provider.ts',
  'src/main/daemon/daemon-pty-router.ts',
  'src/main/daemon/degraded-daemon-pty-provider.ts',
  'src/main/daemon/daemon-pty-adapter.ts'
]

/** Where the provider-side settlement is actually decided; the adapter inherits its own. */
const SETTLED_WRITER_DECLARATIONS = [
  'src/main/providers/local-pty-provider.ts',
  'src/main/providers/ssh-pty-provider.ts',
  'src/main/providers/ssh-pty-provider-rpc-operations.ts',
  'src/main/daemon/daemon-pty-router.ts',
  'src/main/daemon/degraded-daemon-pty-provider.ts',
  'src/main/daemon/daemon-pty-session-input.ts'
]

function declaredProviderFiles(): string[] {
  const output = execFileSync('git', ['grep', '-l', '--', 'implements IPtyProvider', 'src/main'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })
  // Tests may name the clause while pinning it; only production declarations count.
  return output
    .split('\n')
    .filter((file) => file && !file.endsWith('.test.ts'))
    .sort()
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
    const daemonClient = { isConnected: () => false, onEvent: vi.fn(() => vi.fn()) }
    const adapter = new DaemonPtyAdapter(daemonClient as never)
    const instances = [
      new LocalPtyProvider({} as never),
      new SshPtyProvider('conn-census', createMockMux() as never),
      new DaemonPtyRouter({ current: adapter, legacy: [] }),
      new DegradedDaemonPtyProvider({
        current: adapter,
        legacy: [],
        fallback: new LocalPtyProvider({} as never)
      }),
      adapter
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
