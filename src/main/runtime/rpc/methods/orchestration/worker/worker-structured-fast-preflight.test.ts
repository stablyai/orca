import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { CODEX_STRUCTURED_AGENT } from '../../../../../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../../../../../claude/claude-structured-agent-definition'
import type { AgentSessionModelCatalogResult } from '../../../../../../shared/agent-session-wire'
import { preflightStructuredWorkerFast } from './worker-structured-fast-preflight'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'
import { narrowStructuredLaunchSeedOptions } from '../../../../../../shared/native-chat/input/native-chat-session-option-defaults'

afterEach(() => setStructuredAgentSessionHost(null))

function fixture(listing: AgentSessionModelCatalogResult) {
  const read = vi.fn(async () => listing)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only the registry definition and saved model catalog; it creates no session.
  setStructuredAgentSessionHost({
    deps: {
      agents: {
        definition: (agent: string) =>
          agent === 'claude' ? CLAUDE_STRUCTURED_AGENT : CODEX_STRUCTURED_AGENT
      },
      modelCatalog: { read }
    }
  } as never)
  const runtime = {
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => '/project/folder')
  }
  return { runtime, read }
}

describe('structured worker Fast preflight', () => {
  it.each(['claude', 'codex'] as const)(
    'uses the existing %s catalog and durable Fast seed without creating a session',
    async (agent) => {
      const f = fixture({
        origin: 'probe',
        fetchedAt: 10,
        models: [
          {
            id: 'current-model',
            label: 'Current',
            isDefault: true,
            efforts: [],
            supportsFastMode: true,
            serviceTiers: [{ value: 'priority', label: 'Fast' }]
          }
        ]
      })
      const serviceTier = await preflightStructuredWorkerFast({
        runtime: f.runtime,
        agent,
        worktree: 'id:folder',
        model: 'current-model',
        fastMode: true
      })
      expect(serviceTier).toEqual(agent === 'codex' ? 'priority' : undefined)
      const launch = resolveWorkerLaunchPreferences({
        agent,
        role: 'review',
        model: 'current-model',
        fastMode: true,
        structuredFastModeSupported: true,
        structuredFastServiceTier: serviceTier
      })
      expect(narrowStructuredLaunchSeedOptions(launch.preferences)).toEqual({
        model: 'current-model',
        ...(agent === 'codex' ? { serviceTier: 'priority' } : { fastMode: 'true' })
      })
      expect(launch.receipt).toMatchObject({
        role: 'review',
        effective: {
          agent,
          model: 'current-model',
          fastMode: true,
          ...(agent === 'codex' ? { serviceTier: 'priority' } : {})
        }
      })
      expect(f.read).toHaveBeenCalledWith({
        agent,
        workspacePath: '/project/folder',
        savedOnly: true,
        verifiedOnly: true
      })
    }
  )

  it.each([
    { origin: 'unknown' },
    { origin: 'probe', fetchedAt: 1, models: [] },
    {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'current-model',
          label: 'Current',
          isDefault: true,
          efforts: [],
          supportsFastMode: false
        }
      ]
    }
  ] satisfies AgentSessionModelCatalogResult[])(
    'refuses unknown or unsupported Fast before a Task exists',
    async (listing) => {
      const f = fixture(listing)
      await expect(
        preflightStructuredWorkerFast({
          runtime: f.runtime,
          agent: 'claude',
          worktree: 'id:folder',
          model: 'current-model',
          fastMode: true
        })
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
    }
  )

  it('does not turn an account restriction into an enabled Fast request', async () => {
    const f = fixture({
      origin: 'probe',
      fetchedAt: 1,
      fastModeSupport: { supported: false, reason: 'account' },
      models: [
        {
          id: 'current-model',
          label: 'Current',
          isDefault: true,
          efforts: [],
          supportsFastMode: true
        }
      ]
    })
    await expect(
      preflightStructuredWorkerFast({
        runtime: f.runtime,
        agent: 'claude',
        worktree: 'id:folder',
        model: 'current-model',
        fastMode: true
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
  })
})
