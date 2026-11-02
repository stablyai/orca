import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, setPlatform } from '../orca-runtime-test-mocks.spec'
import type { RuntimeTerminalAgentStatusEvent } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('replaces a cwd parsed before late WSL context with the provider cwd', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'pty-late-wsl-context'
    const providerCwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 }),
      serializeProviderBuffer: vi.fn().mockResolvedValue({
        data: 'restored screen',
        cols: 80,
        rows: 24,
        cwd: providerCwd,
        seq: 1,
        source: 'headless'
      })
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID)
    runtime.seedHeadlessTerminal(ptyId, '\x1b]7;file://DESKTOP/home/me/repo\x07')

    const internals = runtime as unknown as {
      headlessTerminals: Map<string, { writeChain: Promise<void> }>
      terminalCwdByPtyId: Map<string, string>
    }
    await internals.headlessTerminals.get(ptyId)?.writeChain
    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe('\\\\desktop\\home\\me\\repo')

    runtime.preparePtyExecutionContext(ptyId, 'Ubuntu')
    await internals.headlessTerminals.get(ptyId)?.writeChain

    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe(providerCwd)
  })

  it('keeps a live WSL cwd that arrives during late-context snapshot recovery', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    const ptyId = 'pty-late-wsl-context-race'
    type ProviderSnapshot = {
      data: string
      cols: number
      rows: number
      cwd: string
      seq: number
      source: 'headless'
    }
    let resolveProviderSnapshot: ((snapshot: ProviderSnapshot) => void) | undefined
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 }),
      serializeProviderBuffer: vi.fn(
        () =>
          new Promise<ProviderSnapshot>((resolve) => {
            resolveProviderSnapshot = resolve
          })
      )
    })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID)
    runtime.seedHeadlessTerminal(ptyId, '\x1b]7;file://DESKTOP/home/me/old\x07')
    const internals = runtime as unknown as {
      headlessTerminals: Map<string, { writeChain: Promise<void> }>
      terminalCwdByPtyId: Map<string, string>
    }
    await internals.headlessTerminals.get(ptyId)?.writeChain

    runtime.preparePtyExecutionContext(ptyId, 'Ubuntu')
    await vi.waitFor(() => expect(resolveProviderSnapshot).toBeDefined())
    runtime.onPtyData(ptyId, '\x1b]7;file://DESKTOP/home/me/live\x07', 1)
    resolveProviderSnapshot?.({
      data: 'older restored screen',
      cols: 80,
      rows: 24,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\old',
      seq: 1,
      source: 'headless'
    })
    await internals.headlessTerminals.get(ptyId)?.writeChain

    expect(internals.terminalCwdByPtyId.get(ptyId)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\live'
    )
  })

  it('infers local reconstructed WSL context from a WSL UNC worktree', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty(
      'pty-reconstructed',
      `${TEST_REPO_ID}::\\\\wsl.localhost\\Ubuntu\\home\\me\\repo`
    )

    runtime.onPtyData('pty-reconstructed', '\x1b]7;file://DESKTOP/home/me/repo/src\x07', 1)

    const cwd = (
      runtime as unknown as { terminalCwdByPtyId: Map<string, string> }
    ).terminalCwdByPtyId.get('pty-reconstructed')
    expect(cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src')
  })

  it('clears stale terminal file URI hostnames after empty-host OSC7 cwd updates', () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07', 123)
    runtime.onPtyData('pty-ssh', '\x1b]7;file:///home/me/repo/src\x07', 124)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
      terminalFileUriHostnameByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh')).toBe('/home/me/repo/src')
    expect(internals.terminalFileUriHostnameByPtyId.has('pty-ssh')).toBe(false)
  })

  it('serializes SSH headless OSC7 cwd as POSIX when the desktop runtime is on Windows', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07hello', 123)

    const snapshot = await (
      runtime as unknown as {
        serializeHeadlessTerminalBuffer: (
          ptyId: string,
          opts: { includeEmpty?: boolean }
        ) => Promise<{ cwd?: string | null } | null>
      }
    ).serializeHeadlessTerminalBuffer('pty-ssh', { includeEmpty: true })

    expect(snapshot?.cwd).toBe('/home/me/repo/src')
  })

  it('projects frame-independent live state through main buffer snapshots', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-frame-state', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-frame-state', '\x1b[?1049h\x1b[?1004h\x1b[?25lSTATIC-FRAME', 123)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-frame-state')

    expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?1004h')
    expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?25l')
    expect(snapshot?.frameRestoreAnsi).not.toContain('STATIC-FRAME')
    expect(snapshot?.data).toContain('STATIC-FRAME')
  })

  it('keeps Windows SSH OSC7 cwd as a drive path when the desktop runtime is POSIX', () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh-win', `${TEST_REPO_ID}::C:/Users/me/repo`, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh-win', '\x1b]7;file:///C:/Users/me/repo/src\x07', 123)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh-win')).toBe('C:/Users/me/repo/src')
  })

  it('serializes Windows SSH headless OSC7 cwd as a drive path on POSIX desktops', async () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(store)
    runtime.registerPty('pty-ssh-win', `${TEST_REPO_ID}::C:/Users/me/repo`, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh-win', '\x1b]7;file:///C:/Users/me/repo/src\x07hello', 123)

    const snapshot = await (
      runtime as unknown as {
        serializeHeadlessTerminalBuffer: (
          ptyId: string,
          opts: { includeEmpty?: boolean }
        ) => Promise<{ cwd?: string | null } | null>
      }
    ).serializeHeadlessTerminalBuffer('pty-ssh-win', { includeEmpty: true })

    expect(snapshot?.cwd).toBe('C:/Users/me/repo/src')
  })

  it('infers restored SSH connection identity from app-scoped PTY ids', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const ptyId = 'ssh:ssh-restored@@relay-pty'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })

    runtime.onPtyData(ptyId, '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId,
        connectionId: 'ssh-restored',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })
})
