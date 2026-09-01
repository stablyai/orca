// W1 oracle-16 rider: a custom agent id must flow through the runtime's built-in-
// keyed registry sites via the base accessor (resolveAgentConfigForRegistry), not
// index the static config map directly. tsc cannot verify this (noImplicitAny is
// off in the toolkit tsconfig, so a custom id silently yields `any`/undefined), so
// these tests are the oracle: a custom codex id resolves to its base's config and
// takes the codex trust/draft path — it neither throws nor silently defaults.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const markCodexProjectTrusted = vi.fn()
const markCopilotFolderTrusted = vi.fn()
const markCursorWorkspaceTrusted = vi.fn()
vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: (path: string) => markCodexProjectTrusted(path),
  markCopilotFolderTrusted: (path: string) => markCopilotFolderTrusted(path),
  markCursorWorkspaceTrusted: (path: string) => markCursorWorkspaceTrusted(path)
}))

const markRemoteAgentWorkspaceTrusted = vi.fn(async (_args: unknown) => {})
vi.mock('../remote-agent-trust-presets', () => ({
  markRemoteAgentWorkspaceTrusted: (args: unknown) => markRemoteAgentWorkspaceTrusted(args)
}))

const createDraftPasteReadyScanner = vi.fn((_signal: string) => ({
  observe: () => ({ ready: true })
}))
vi.mock('../../shared/draft-paste-ready-scanner', () => ({
  createDraftPasteReadyScanner: (signal: string) => createDraftPasteReadyScanner(signal)
}))

// A live custom codex agent — resolves to base `codex`, whose config carries
// preflightTrust:'codex' and draftPasteReadySignal:'codex-composer-prompt'.
const CUSTOM_CODEX_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd'
const SETTINGS = {
  customTuiAgents: [{ id: CUSTOM_CODEX_ID, baseAgent: 'codex' }],
  deletedCustomTuiAgents: []
}

type RegistrySafetyInternals = {
  store: { getSettings: () => unknown }
  markLocalWorkspaceTrustedForAgent: (agent: string, workspacePath: string) => void
  markRemoteWorkspaceTrustedForAgent: (
    agent: string,
    connectionId: string,
    workspacePath: string
  ) => Promise<void>
  waitForStartupDraftReady: (handle: string, agent: string) => Promise<string | null>
  getLivePtyForHandle: (handle: string) => unknown
  subscribeToTerminalData: (ptyId: string, cb: (data: string) => void) => () => void
  recentPtyOutputById: Map<string, { read: () => string }>
}

function makeRuntime(): RegistrySafetyInternals {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as RegistrySafetyInternals
  internals.store = { getSettings: () => SETTINGS }
  return internals
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('runtime registry safety (oracle 16): custom id resolves via base', () => {
  it('markLocalWorkspaceTrustedForAgent takes the codex trust path, not a crash or default', () => {
    const internals = makeRuntime()
    expect(() =>
      internals.markLocalWorkspaceTrustedForAgent(CUSTOM_CODEX_ID, '/ws/custom-codex')
    ).not.toThrow()
    expect(markCodexProjectTrusted).toHaveBeenCalledWith('/ws/custom-codex')
    expect(markCursorWorkspaceTrusted).not.toHaveBeenCalled()
    expect(markCopilotFolderTrusted).not.toHaveBeenCalled()
  })

  it('markRemoteWorkspaceTrustedForAgent resolves the codex preset from the base', async () => {
    const internals = makeRuntime()
    await expect(
      internals.markRemoteWorkspaceTrustedForAgent(CUSTOM_CODEX_ID, 'conn-1', '/ws/remote-codex')
    ).resolves.toBeUndefined()
    expect(markRemoteAgentWorkspaceTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      connectionId: 'conn-1',
      workspacePath: '/ws/remote-codex'
    })
  })

  it('waitForStartupDraftReady picks the base draft signal, not the silent default', async () => {
    const internals = makeRuntime()
    internals.getLivePtyForHandle = () => ({ pty: { ptyId: 'p1' } })
    internals.subscribeToTerminalData = () => () => {}
    // The runtime replays buffered output through the buffer's read(), not a raw string.
    internals.recentPtyOutputById = new Map([['p1', { read: () => 'ready-bytes' }]])
    await expect(internals.waitForStartupDraftReady('term-1', CUSTOM_CODEX_ID)).resolves.toBe('p1')
    // Base-resolved codex signal — NOT the render-quiet-after-bracketed-paste default.
    expect(createDraftPasteReadyScanner).toHaveBeenCalledWith('codex-composer-prompt')
  })
})
