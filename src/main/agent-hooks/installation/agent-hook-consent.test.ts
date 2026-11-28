import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_HOOK_TARGETS,
  type AgentHookInstallStatus,
  type AgentHookTarget
} from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import type { AgentHookConsent } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'

type Calls = { installed: string[]; refreshed: string[]; removed: string[]; present: Set<string> }
const calls = vi.hoisted((): Calls => ({
  installed: [],
  refreshed: [],
  removed: [],
  present: new Set()
}))

function status(agent: AgentHookTarget, present: boolean): AgentHookInstallStatus {
  return {
    agent,
    state: present ? 'installed' : 'not_installed',
    configPath: `/home/${agent}.json`,
    managedHooksPresent: present,
    detail: null
  }
}

vi.mock('./managed-agent-hook-registry', async () => {
  const { AGENT_HOOK_TARGETS: agents } =
    await import('../../../shared/agent-hook-listener/configuration/agent-hook-types')
  return {
    MANAGED_AGENT_HOOK_INSTALLERS: agents.map((agent) => [
      agent,
      () => {
        calls.installed.push(agent)
        return status(agent, true)
      }
    ]),
    MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS: agents.map((agent) => [
      agent,
      async () => {
        calls.refreshed.push(agent)
      }
    ]),
    MANAGED_AGENT_HOOK_REMOVERS: agents.map((agent) => [
      agent,
      () => {
        calls.removed.push(agent)
        return status(agent, false)
      }
    ]),
    MANAGED_AGENT_HOOK_ASYNC_REMOVERS: [],
    MANAGED_AGENT_HOOK_STATUS_READERS: agents.map((agent) => [
      agent,
      () => status(agent, calls.present.has(agent))
    ])
  }
})

vi.mock('./local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: async (targets: { agent: string }[]) =>
    Object.fromEntries(targets.map((t) => [t.agent, { state: 'found' }]))
}))

vi.mock('../../claude/cli-capabilities/claude-hook-event-versions', () => ({
  probeClaudeCliVersion: async () => null
}))

vi.mock('./install-telemetry', () => ({ recordManagedHookInstallFailure: () => {} }))

const { applyAgentStatusHooksEnabled, installManagedAgentHooks } =
  await import('./managed-agent-hook-controls')
const { reconcileStartupManagedAgentHooks } = await import('./managed-agent-hook-startup')

beforeEach(() => {
  calls.installed = []
  calls.refreshed = []
  calls.removed = []
  calls.present = new Set()
})

const consent: AgentHookConsent = { claude: 'granted', codex: 'declined' }
const settings = { agentStatusHooksEnabled: true, disabledTuiAgents: [], agentHookConsent: consent }

describe('agent hook consent', () => {
  it('never installs or refreshes an undecided or declined agent, on any install path', async () => {
    await installManagedAgentHooks(settings)
    await applyAgentStatusHooksEnabled(true, settings, { userInitiated: true })
    await installManagedAgentHooks(settings, { agents: [...AGENT_HOOK_TARGETS] })

    expect(new Set(calls.installed)).toEqual(new Set(['claude']))
    expect(new Set(calls.refreshed)).toEqual(new Set(['claude']))
    expect(calls.removed).toEqual([])
  })

  it('startup adopts present hooks as granted and never removes anything', async () => {
    calls.present = new Set(['claude', 'codex', 'cursor'])
    const declinedCodex: AgentHookConsent = { codex: 'declined' }
    let current = { ...settings, agentHookConsent: declinedCodex }
    reconcileStartupManagedAgentHooks({
      getSettings: () => current,
      writeConsent: (agentHookConsent) => {
        current = { ...current, agentHookConsent }
      },
      isQuitting: () => false,
      shouldHydrateShellPath: false
    })
    await vi.waitFor(() => expect(calls.installed.length).toBeGreaterThan(0))

    // Undecided agents with hooks are adopted; an earlier "declined" is never overturned.
    expect(current.agentHookConsent).toEqual({
      claude: 'granted',
      codex: 'declined',
      cursor: 'granted'
    })
    expect(new Set(calls.installed)).toEqual(new Set(['claude', 'cursor']))
    expect(calls.removed).toEqual([])
  })
})
