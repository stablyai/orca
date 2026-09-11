/**
 * The host-side preflight behind `agentSession.createSupport`. A structured create never runs the
 * terminal lane's credential preparation, so without this the child spawns and fails its auth
 * mid-stream. Refusing needs a positively observed empty account home; anything unreadable answers
 * as a login would.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const originalPlatform = process.platform
const created: string[] = []
const clearedEnv: [string, string | undefined][] = []

/** macOS keeps the Claude login in the keychain, so only a non-darwin host can observe absence. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function providerHome(files: Record<string, string> = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'preflight-home-'))
  created.push(path)
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(path, name), contents, 'utf-8')
  }
  return path
}

/** Runs `createSupport` against the real runtime with both providers pointed at `home`. */
function runtimeWithProviderHome(home: string | null): {
  runtime: OrcaRuntimeService
  ensureHost: ReturnType<typeof vi.fn>
} {
  const agentDefaultEnv = home
    ? { claude: { CLAUDE_CONFIG_DIR: home }, codex: { CODEX_HOME: home } }
    : {}
  const runtime = new OrcaRuntimeService({ getSettings: () => ({ agentDefaultEnv }) } as never)
  const ensureHost = vi.fn(async () => {
    setStructuredAgentSessionHost({ supportsCreate: () => true } as never)
  })
  const internal = runtime as unknown as {
    resolveStructuredAgentSessionLocation: () => Promise<unknown>
    ensureStructuredAgentSessionHost: () => Promise<void>
  }
  internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree' as const
  }))
  internal.ensureStructuredAgentSessionHost = ensureHost
  return { runtime, ensureHost }
}

beforeEach(() => {
  setPlatform('linux')
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_API_KEY',
    'OPENAI_API_KEY'
  ]) {
    clearedEnv.push([name, process.env[name]])
    delete process.env[name]
  }
})

afterEach(() => {
  setPlatform(originalPlatform)
  for (const [name, value] of clearedEnv.splice(0)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  setStructuredAgentSessionHost(null)
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('structured create-support provider-login preflight', () => {
  it.each(['claude', 'codex'] as const)(
    'refuses a %s create with a typed reason when the host holds no login',
    async (agent) => {
      const { runtime, ensureHost } = runtimeWithProviderHome(providerHome())

      await expect(
        runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', agent)
      ).resolves.toEqual({ supported: false, reason: 'login' })
      // The refusal is pre-spawn: nothing that could start a provider child was even installed.
      expect(ensureHost).not.toHaveBeenCalled()
      expect(getStructuredAgentSessionHost()).toBeNull()
    }
  )

  it('supports Claude when the host holds a login', async () => {
    const home = providerHome({ '.credentials.json': '{"claudeAiOauth":{}}' })
    const { runtime } = runtimeWithProviderHome(home)

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toEqual({ supported: true })
  })

  it('supports Codex when the host holds a login', async () => {
    const home = providerHome({ 'auth.json': '{"tokens":{}}' })
    const { runtime } = runtimeWithProviderHome(home)

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')
    ).resolves.toEqual({ supported: true })
  })

  /** Loss of contact with the evidence is not evidence of absence. */
  it('does not refuse when the account home cannot be read as one', async () => {
    const home = join(providerHome({ blocked: 'a file where a home should be' }), 'blocked')
    const { runtime } = runtimeWithProviderHome(home)

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')
    ).resolves.toEqual({ supported: true })
  })

  it('does not refuse when the Claude settings will not parse', async () => {
    const { runtime } = runtimeWithProviderHome(providerHome({ 'settings.json': '{ not json' }))

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'claude')
    ).resolves.toEqual({ supported: true })
  })

  it('does not refuse when the settings cannot name the account home', async () => {
    const { runtime } = runtimeWithProviderHome(null)
    const internal = runtime as unknown as { requireStore: () => never }
    internal.requireStore = () => {
      throw new Error('no store')
    }

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'codex')
    ).resolves.toMatchObject({ supported: true })
  })
})
