// Test-only: the fakes both kept-account spawn suites share, so their casts live in one place.
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
import { installAgentRunAccounts } from '../agent-accounts/agent-run-accounts-installed'
import type { AgentRunAccounts } from '../agent-accounts/agent-run-accounts'
import type {
  KeptAgentConversations,
  KeptConversation
} from '../agent-accounts/kept-agent-conversations'

export type SpawnOptions = { env?: Record<string, string> }

/** Installs a kept-conversations index (and a producer that only records launches). */
export function installKeptIndex(entries: Record<string, KeptConversation> | 'unavailable'): Mock {
  const notePaneLaunch = vi.fn()
  const kept: Pick<KeptAgentConversations, 'get'> = {
    get: (provider, sessionId) =>
      entries === 'unavailable' ? 'unavailable' : (entries[`${provider}:${sessionId}`] ?? null)
  }
  installAgentRunAccounts({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawns call only notePaneLaunch on the producer.
    producer: { notePaneLaunch } as unknown as AgentRunAccounts,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawns call only get on the index.
    kept: kept as KeptAgentConversations
  })
  return notePaneLaunch
}

export function installFakeLocalProvider(
  id: string
): Mock<(options: SpawnOptions) => Promise<{ id: string }>> {
  const spawn = vi.fn(async (_options: SpawnOptions) => ({ id }))
  const provider = {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    listProcesses: vi.fn(async () => []),
    getForegroundProcess: vi.fn(async () => null)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a spawn reaches only the provider members defined above.
  setLocalPtyProvider(provider as never)
  return spawn
}

/** A runtime that only takes the controller registerPtyHandlers installs. */
export function fakeRuntime(): {
  runtime: unknown
  spawn: (args: Record<string, unknown>) => Promise<{ id: string }>
} {
  const runtime = {
    setPtyController: vi.fn(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn()
  }
  return {
    runtime,
    spawn: (args) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerPtyHandlers hands the runtime its pty controller, whose spawn takes these args.
      const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
        spawn(spawnArgs: Record<string, unknown>): Promise<{ id: string }>
      }
      return controller.spawn(args)
    }
  }
}

export function registerKeptAccountHandlers(args: {
  mainWindow: unknown
  runtime?: unknown
  settings: Record<string, unknown>
  getSelectedCodexHomePath?: () => string
  prepareClaudeAuth?: unknown
  prepareCodexSessionResume?: unknown
}): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the window, runtime, settings and launch preparation these fakes define.
  const handlerArgs = [
    args.mainWindow,
    args.runtime,
    args.getSelectedCodexHomePath,
    () => args.settings,
    args.prepareClaudeAuth,
    undefined,
    args.prepareCodexSessionResume
      ? { prepareCodexSessionResume: args.prepareCodexSessionResume }
      : undefined
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...handlerArgs)
}
