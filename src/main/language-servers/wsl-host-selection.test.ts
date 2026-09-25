import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ClangdSession, openClangdSession } from './clangd-session'
import type { ClangdVersionGateResult } from './clangd-launch'
import type { CompileDbStrategy, CompileDbStrategyFactory } from './language-server-host-types'
import type {
  LanguageServerHostAdapter,
  LanguageServerProcessLaunch
} from './language-server-host-adapter'
import { createLanguageServerHost, LANGUAGE_SERVER_IDLE_TIMEOUT_MS } from './language-server-host'
import { resetHostAdapterCacheForTests, selectHostAdapter } from './language-server-host-adapter'
import { normalizeNativeFilePath } from '../../shared/language-server-path-normalization'

type CapturedOptions = {
  program: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  rootPath: string
  adapterKind?: string
}

function stubSession(): ClangdSession {
  return {
    serverVersion: '23.1.0-test',
    rootPath: '',
    died: null,
    hasDocument: () => true,
    didOpen: () => {},
    didChange: (_f: string, v: number) => v,
    didClose: () => {},
    definition: vi.fn(async () => []),
    references: vi.fn(async () => []),
    declaration: vi.fn(async () => []),
    hover: vi.fn(async () => null),
    semanticTokensFull: vi.fn(async () => ({
      tokenTypes: [],
      tokenModifiers: [],
      tokens: []
    })),
    stop: vi.fn(async () => {})
  } as unknown as ClangdSession
}

function okGate(): (program: string) => Promise<ClangdVersionGateResult> {
  return async () => ({ kind: 'ok', major: 18, message: null })
}

function noopDbFactory(): CompileDbStrategyFactory {
  return () =>
    ({
      resolve: async () => ({ compileCommandsDir: null, degraded: false }),
      dispose: () => {}
    }) as unknown as CompileDbStrategy
}

/**
 * A stub WSL adapter whose async probes (guest env + clangd path + launch)
 * return canned values — so the host-selection test does not require a real
 * WSL distro. The launch it builds mirrors the real WSL shape (wsl.exe --exec
 * + env prefix, WSL_UTF8, interop cwd) so the captured options are realistic.
 */
function stubWslAdapter(): LanguageServerHostAdapter {
  return {
    kind: 'wsl',
    normalizeKey: normalizeNativeFilePath,
    pathToLspUri: (p) => `file:///guest${p.replace(/\\/g, '/').replace(/.*repo/, '')}`,
    lspUriToPath: (uri) => String.raw`\\wsl.localhost\Ubuntu\repo` + uri,
    resolveClangdProgram: () => 'wsl.exe',
    resolveClangdVersionGate: async () => ({ kind: 'ok', major: 18, message: null }),
    async buildLaunch(): Promise<LanguageServerProcessLaunch> {
      return {
        program: 'wsl.exe',
        args: [
          '-d',
          'Ubuntu',
          '--exec',
          '/usr/bin/env',
          'PATH=/usr/bin',
          'HOME=/home/u',
          '/usr/bin/clangd',
          '--log=info'
        ],
        cwd: 'C:\\Users\\test',
        env: { WSL_UTF8: '1' }
      }
    },
    openProcess: () => ({}) as never,
    createDbStrategy: () =>
      ({
        resolve: async () => ({ compileCommandsDir: null, degraded: false }),
        dispose: () => {}
      }) as unknown as CompileDbStrategy
  }
}

describe('selectHostAdapter — production selection (real adapters)', () => {
  beforeEach(() => {
    resetHostAdapterCacheForTests()
  })

  it('selects native for a drive worktree root and WSL for a UNC root', () => {
    expect(selectHostAdapter('D:\\repo').kind).toBe('native')
    expect(selectHostAdapter(String.raw`\\wsl.localhost\Ubuntu\home\u\repo`).kind).toBe('wsl')
  })
})

describe('createLanguageServerHost — WSL host selection (ticket 16, stubbed adapter)', () => {
  it('selects the WSL adapter for a wsl.localhost worktree and passes WSL-shaped launch', async () => {
    const captured: CapturedOptions[] = []
    const session = stubSession()
    const host = createLanguageServerHost(
      {},
      (async (options) => {
        captured.push({
          program: options.program,
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          rootPath: options.rootPath,
          adapterKind: options.adapter?.kind
        })
        return session
      }) as unknown as typeof openClangdSession,
      okGate(),
      noopDbFactory(),
      () => stubWslAdapter()
    )
    await host.openDocument({
      worktreeRoot: String.raw`\\wsl.localhost\Ubuntu\home\u\repo`,
      filePath: String.raw`\\wsl.localhost\Ubuntu\home\u\repo\src\main.cpp`,
      text: 'int main() {}\n'
    })
    expect(captured).toHaveLength(1)
    const opts = captured[0]
    expect(opts.adapterKind).toBe('wsl')
    // The spawn program is wsl.exe (resolved path or bare name fallback).
    expect(opts.program).toMatch(/wsl\.exe$/i)
    // The launch argv carries --exec (shell-free, no capture fence — spec D8).
    expect(opts.args).toContain('--exec')
    // WSL sets WSL_UTF8 so wsl.exe's own messages are readable.
    expect(opts.env?.WSL_UTF8).toBe('1')
    // The process cwd is the wsl.exe interop spawn dir (a Windows dir), NOT
    // the guest worktree root — the guest cwd is irrelevant given rootUri.
    expect(opts.cwd).not.toBe(opts.rootPath)
  })

  it('applies the idle-shutdown lifecycle to a WSL session identically (spec §6)', async () => {
    vi.useFakeTimers()
    try {
      const session = stubSession()
      const host = createLanguageServerHost(
        {},
        (async () => session) as unknown as typeof openClangdSession,
        okGate(),
        noopDbFactory(),
        () => stubWslAdapter()
      )
      await host.openDocument({
        worktreeRoot: String.raw`\\wsl.localhost\Ubuntu\home\u\repo`,
        filePath: String.raw`\\wsl.localhost\Ubuntu\home\u\repo\src\main.cpp`,
        text: 'x'
      })
      expect(host.sessionCount).toBe(1)
      host.closeDocument({
        filePath: String.raw`\\wsl.localhost\Ubuntu\home\u\repo\src\main.cpp`
      })
      await vi.advanceTimersByTimeAsync(LANGUAGE_SERVER_IDLE_TIMEOUT_MS)
      expect(session.stop).toHaveBeenCalledTimes(1)
      expect(host.sessionCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the LRU cap eviction to WSL sessions identically (spec §6)', async () => {
    const stopped: string[] = []
    const stubs = [stubSession(), stubSession(), stubSession(), stubSession()]
    stubs.forEach((s, i) => {
      s.stop = vi.fn(async () => {
        stopped.push(`wt-${i}`)
      })
    })
    let next = 0
    const host = createLanguageServerHost(
      { onToast: () => {} },
      (async () => {
        const s = stubs[next] ?? stubs[0]
        next += 1
        return s
      }) as unknown as typeof openClangdSession,
      okGate(),
      noopDbFactory(),
      () => stubWslAdapter()
    )
    const root = (n: number) => String.raw`\\wsl.localhost\Ubuntu\home\u\repo${n}`
    const file = (n: number) => String.raw`\\wsl.localhost\Ubuntu\home\u\repo${n}\a.cpp`
    await host.openDocument({ worktreeRoot: root(0), filePath: file(0), text: 'x' })
    await host.openDocument({ worktreeRoot: root(1), filePath: file(1), text: 'x' })
    await host.openDocument({ worktreeRoot: root(2), filePath: file(2), text: 'x' })
    expect(host.sessionCount).toBe(3)
    await host.openDocument({ worktreeRoot: root(3), filePath: file(3), text: 'x' })
    expect(host.sessionCount).toBe(3)
    expect(stopped).toHaveLength(1)
  })
})

describe('WSL compile-db strategy (detection-only, ticket 16 scope)', () => {
  it('detects a pre-existing compile_commands.json through the UNC/dir view', async () => {
    const { createWslCompileDbStrategy } = await import('./compile-db/wsl-compile-db-strategy')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'wsl-cdb-'))
    try {
      mkdirSync(join(root, 'build'))
      writeFileSync(join(root, 'build', 'compile_commands.json'), '[]')
      const hooks = { onDegraded: vi.fn(), onStatus: vi.fn(), onToast: vi.fn(), onLog: vi.fn() }
      const strategy = createWslCompileDbStrategy(root, hooks)
      const resolution = await strategy.resolve()
      expect(resolution.degraded).toBe(false)
      expect(resolution.compileCommandsDir).toContain('build')
      expect(hooks.onDegraded).toHaveBeenCalledWith(null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades to single-file when no db exists (no guest cmake — out of scope)', async () => {
    const { createWslCompileDbStrategy } = await import('./compile-db/wsl-compile-db-strategy')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'wsl-cdb-none-'))
    try {
      const hooks = { onDegraded: vi.fn(), onStatus: vi.fn(), onToast: vi.fn(), onLog: vi.fn() }
      const strategy = createWslCompileDbStrategy(root, hooks)
      const resolution = await strategy.resolve()
      expect(resolution.degraded).toBe(true)
      expect(resolution.compileCommandsDir).toBeNull()
      expect(hooks.onDegraded).toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
