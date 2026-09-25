import { describe, expect, it, vi } from 'vitest'
import type { ClangdSession, openClangdSession } from './clangd-session'
import type { ClangdVersionGateResult } from './clangd-launch'
import type { CompileDbStrategy, CompileDbStrategyFactory } from './language-server-host-types'
import {
  createLanguageServerHost,
  type ClangdVersionGate,
  type LanguageServerHost
} from './language-server-host'

// Reconnect-replay host integration test (spec §6 + ticket 17): a session that
// dies (transport loss) is respawned on next use, and didOpen is replayed for
// every document that was open when it died, so navigation recovers without the
// user re-opening each tab.
function okGate(): ClangdVersionGate {
  return async () => ({ kind: 'ok', major: 18, message: null }) as ClangdVersionGateResult
}
function noopDb(): CompileDbStrategyFactory {
  return () =>
    ({
      resolve: async () => ({ compileCommandsDir: null, degraded: false }),
      dispose: () => {}
    }) as unknown as CompileDbStrategy
}

describe('createLanguageServerHost reconnect replay', () => {
  it('replays didOpen for open documents after a died session is respawned', async () => {
    const didOpen = vi.fn()
    const refs = { onExit: null as ((error: Error | null) => void) | null }
    let died: Error | null = null
    const session = {
      serverVersion: '18',
      rootPath: '/r',
      get died() {
        return died
      },
      hasDocument: () => true,
      didOpen,
      didChange: () => 1,
      didClose: () => {},
      definition: vi.fn(async () => []),
      references: vi.fn(async () => []),
      declaration: vi.fn(async () => []),
      hover: vi.fn(async () => null),
      stop: vi.fn(async () => {}),
      ...({} as Partial<ClangdSession>)
    } as unknown as ClangdSession
    const startCalls: { rootPath: string }[] = []
    const host: LanguageServerHost = createLanguageServerHost(
      { onLog: () => {} },
      (async (options) => {
        startCalls.push({ rootPath: options.rootPath })
        refs.onExit = options.onExit
        return session
      }) as unknown as typeof openClangdSession,
      okGate(),
      noopDb()
    )
    // Open two documents.
    await host.openDocument({ worktreeRoot: '/r', filePath: '/r/a.cpp', text: 'int a;' })
    await host.openDocument({ worktreeRoot: '/r', filePath: '/r/b.cpp', text: 'int b;' })
    didOpen.mockClear()
    // The session dies (transport loss). The onExit callback retains the open
    // documents for replay; the host drops the session.
    died = new Error('connection lost')
    refs.onExit?.(died)
    // Next use respawns the session (same key), and replays didOpen.
    await host.openDocument({ worktreeRoot: '/r', filePath: '/r/a.cpp', text: 'int a;' })
    // didOpen replayed for both retained docs on respawn, plus the new openDocument.
    expect(didOpen).toHaveBeenCalledTimes(3)
    expect(didOpen).toHaveBeenCalledWith('/r/a.cpp', 'int a;')
    expect(didOpen).toHaveBeenCalledWith('/r/b.cpp', 'int b;')
    // Two spawns: initial + respawn.
    expect(startCalls).toHaveLength(2)
  })

  it('does not replay when the session shuts down cleanly (no open docs retained)', async () => {
    const didOpen = vi.fn()
    let died: Error | null = null
    const refs = { onExit: null as ((error: Error | null) => void) | null }
    const session = {
      serverVersion: '18',
      rootPath: '/r',
      get died() {
        return died
      },
      hasDocument: () => true,
      didOpen,
      didChange: () => 1,
      didClose: () => {},
      definition: vi.fn(async () => []),
      references: vi.fn(async () => []),
      declaration: vi.fn(async () => []),
      hover: vi.fn(async () => null),
      stop: vi.fn(async () => {}),
      ...({} as Partial<ClangdSession>)
    } as unknown as ClangdSession
    const host: LanguageServerHost = createLanguageServerHost(
      {},
      (async (options) => {
        refs.onExit = options.onExit
        return session
      }) as unknown as typeof openClangdSession,
      okGate(),
      noopDb()
    )
    await host.openDocument({ worktreeRoot: '/r', filePath: '/r/a.cpp', text: 'int a;' })
    host.closeDocument({ filePath: '/r/a.cpp' })
    didOpen.mockClear()
    died = new Error('crash')
    refs.onExit?.(died)
    // No open docs retained → respawn replays nothing.
    await host.openDocument({ worktreeRoot: '/r', filePath: '/r/a.cpp', text: 'int a;' })
    expect(didOpen).toHaveBeenCalledTimes(1)
  })
})
