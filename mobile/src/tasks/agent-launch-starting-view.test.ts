import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { finalizeAgentTabStartingView } from '../../../src/shared/native-chat-starting-view'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { writeDefaultSessionViewState } from '../storage/default-session-view-state'
import {
  refreshDefaultSessionView,
  resetDefaultSessionViewStoreForTests
} from '../storage/default-session-view-store'
import {
  readDefaultSessionViewPreference,
  type MobileSessionView
} from '../storage/session-view-preferences'
import type { TerminalTabViewMode } from '../../../src/shared/terminal-tab-view-mode'
import {
  agentLaunchCreateParams,
  agentLaunchExistingParams,
  phoneLauncherDefaultView,
  readAgentLaunchSupport
} from './agent-launch-request'
import { createWorktreeWithNameRetry } from './worktree-create-retry'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'

vi.mock('../storage/session-view-preferences', () => ({
  DEFAULT_SESSION_VIEW: 'terminal',
  readDefaultSessionViewPreference: vi.fn(),
  saveDefaultSessionView: vi.fn(async () => {})
}))

const CAPABLE = [AGENT_LAUNCH_RUNTIME_CAPABILITY, AGENT_TAB_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY]

afterEach(() => {
  resetDefaultSessionViewStoreForTests()
})

describe("the phone's launch starting view", () => {
  it("sends the phone's loaded default to a host that stamps it", () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true, hasStoredValue: true })
    expect(phoneLauncherDefaultView(CAPABLE)).toBe('chat')
    writeDefaultSessionViewState({ value: 'terminal', settled: true, hasStoredValue: true })
    expect(phoneLauncherDefaultView(CAPABLE)).toBe('terminal')
  })

  it('sends nothing while the default store has not loaded, so the host default applies', () => {
    expect(phoneLauncherDefaultView(CAPABLE)).toBeUndefined()
    writeDefaultSessionViewState({ value: 'terminal', settled: false, hasStoredValue: true })
    expect(phoneLauncherDefaultView(CAPABLE)).toBeUndefined()
  })

  it('sends nothing while the user never chose a default, so the host default applies', () => {
    writeDefaultSessionViewState({ value: 'terminal', settled: true, hasStoredValue: false })
    expect(phoneLauncherDefaultView(CAPABLE)).toBeUndefined()
  })

  it('sends nothing to a host without launch-presentation stamping', () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true, hasStoredValue: true })
    expect(phoneLauncherDefaultView([AGENT_LAUNCH_RUNTIME_CAPABILITY])).toBeUndefined()
  })

  it('reads the capability into the launch support', () => {
    expect(readAgentLaunchSupport([AGENT_LAUNCH_RUNTIME_CAPABILITY])).toEqual({ replay: false })
    expect(readAgentLaunchSupport(CAPABLE)).toEqual({ replay: false, launchPresentation: true })
  })

  it('puts the view on both launch builders only when given one', () => {
    expect(
      agentLaunchCreateParams('claude', { repo: 'id:r', name: 'n' }, null, 'chat')
    ).toMatchObject({ launcherDefaultView: 'chat' })
    expect(agentLaunchCreateParams('claude', { repo: 'id:r', name: 'n' })).not.toHaveProperty(
      'launcherDefaultView'
    )
    expect(
      agentLaunchExistingParams({
        agent: 'claude',
        worktreeId: 'wt',
        operationId: 'op',
        launcherDefaultView: 'terminal'
      })
    ).toMatchObject({ launcherDefaultView: 'terminal' })
  })
})

describe('a phone workspace create with an agent', () => {
  it('freezes the view before the first create, so a retry never re-reads a changed default', async () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true, hasStoredValue: true })
    const sent: Record<string, unknown>[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reaches only these four client members.
    const client = {
      getState: () => 'connected',
      getLastInboundAt: () => null,
      onStateChange: () => () => {},
      sendRequest: async (_method: string, params?: unknown) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create sends a params object.
        sent.push(params as Record<string, unknown>)
        if (sent.length === 1) {
          // The user flips the default while the first attempt is in flight.
          writeDefaultSessionViewState({ value: 'terminal', settled: true, hasStoredValue: true })
          return {
            id: '1',
            ok: false,
            error: { code: 'x', message: 'already exists locally' },
            _meta: { runtimeId: 'r' }
          }
        }
        return { id: '2', ok: true, result: { worktreeId: 'wt-1' }, _meta: { runtimeId: 'r' } }
      }
    } as unknown as RpcClient

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: false,
      agentLaunch: { agent: 'claude', supported: { replay: false, launchPresentation: true } }
    })

    expect(result).toMatchObject({ worktreeId: 'wt-1' })
    expect(sent.map((params) => params.launcherDefaultView)).toEqual(['chat', 'chat'])
  })
})

describe('a phone workspace create from an issue or the Tasks screen', () => {
  it("sends the phone's loaded default with the agent startup, and nothing for a blank create", () => {
    writeDefaultSessionViewState({ value: 'chat', settled: true, hasStoredValue: true })
    const base = {
      item: {
        provider: 'github' as const,
        source: { type: 'issue' as const, repoId: 'r', number: 7, title: 'Bug', url: 'https://x/7' }
      },
      targetRepoId: 'r',
      setupDecision: 'skip' as const
    }
    expect(buildTaskWorkspaceCreateParams({ ...base, agent: 'claude' })).toMatchObject({
      launcherDefaultView: 'chat'
    })
    expect(buildTaskWorkspaceCreateParams({ ...base, agent: 'blank' })).not.toHaveProperty(
      'launcherDefaultView'
    )
  })
})

describe('a phone launch onto a host whose Chat UI default is chat', () => {
  const hostChatDefault = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }

  async function hostStartingView(
    stored: MobileSessionView | null
  ): Promise<TerminalTabViewMode | undefined> {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: stored,
      loaded: true,
      hasStoredValue: stored !== null
    })
    await refreshDefaultSessionView()
    const params = agentLaunchExistingParams({
      agent: 'claude',
      worktreeId: 'wt',
      operationId: 'op',
      launcherDefaultView: phoneLauncherDefaultView(CAPABLE)
    })
    return finalizeAgentTabStartingView({
      launcherDefaultView: params.launcherDefaultView,
      settings: hostChatDefault,
      agent: 'claude'
    })
  }

  it("opens in chat when the phone's setting was never changed", async () => {
    await expect(hostStartingView(null)).resolves.toBe('chat')
  })

  it('records nothing when the phone chose terminal', async () => {
    await expect(hostStartingView('terminal')).resolves.toBeUndefined()
  })

  it('opens in chat when the phone chose chat', async () => {
    await expect(hostStartingView('chat')).resolves.toBe('chat')
  })

  it('leaves the view to the host when the phone cannot read its setting', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: false,
      hasStoredValue: false
    })
    await refreshDefaultSessionView()
    expect(phoneLauncherDefaultView(CAPABLE)).toBeUndefined()
  })
})
