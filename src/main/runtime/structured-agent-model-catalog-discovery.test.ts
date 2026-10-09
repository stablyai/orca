import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { registeredModelCatalogDiscovery } from './structured-agent-model-catalog-wiring'
import { acpModelCatalogDiscovery } from './structured-agent-model-catalog-discovery'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import type { StructuredAgentModelCatalogContext } from './structured-agent-runtime-registrations'

// What each probe would have spawned; nothing is.
const spawned = vi.hoisted((): { commands: string[] } => ({ commands: [] }))
vi.mock('../provider-process/managed-provider-process', () => ({
  spawnManagedProviderProcess: (launch: { command: string }) => {
    spawned.commands.push(launch.command)
    throw new Error('no spawn in this test')
  }
}))
vi.mock('../agent-cli-version-probe', () => ({
  probeAgentCliVersion: async (input: { program: string }) => {
    spawned.commands.push(input.program)
    throw new Error('no spawn in this test')
  }
}))

function context(): StructuredAgentModelCatalogContext {
  const unused = async (): Promise<never> => {
    throw new Error('building a probe resolves nothing')
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building a probe only captures resolvers; none of these deps is read until a probe runs.
    deps: { stateDirectory: '/state' } as StructuredAgentModelCatalogContext['deps'],
    environment: {
      resolveBaseEnvironment: unused,
      resolveCodexEnvironment: unused,
      resolveClaudeInheritedEnv: unused
    }
  }
}

describe('the model catalog contract on every registration', () => {
  it.each(
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
      (registration) => [registration.definition.agent, registration] as const
    )
  )('%s declares how its models are listed without a session', (_agent, registration) => {
    const discovery = registration.modelCatalog(context())
    expect(['probe', 'unavailable']).toContain(discovery.kind)
    if (discovery.kind === 'probe') {
      expect(discovery.probe).toBeTypeOf('function')
    } else {
      expect(discovery.reason).not.toBe('')
    }
  })

  it('gives the catalog service a probe for exactly the registrations that have one', () => {
    const { probes } = registeredModelCatalogDiscovery(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      context()
    )
    const listing = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(
      (registration) => registration.modelCatalog(context()).kind === 'probe'
    ).map((registration) => registration.definition.agent)
    expect(Object.keys(probes).sort()).toEqual([...listing].sort())
    // Every agent registered today but OMP lists its models without a session.
    expect(listing.sort()).toEqual(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map((registration) => registration.definition.agent)
        .filter((agent) => agent !== 'omp')
        .sort()
    )
  })

  it('says per registration whether a listing names the model a new chat runs', () => {
    const { listingNamesConfiguredModel } = registeredModelCatalogDiscovery(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      context()
    )
    // Codex's `model/list` names it. Grok's session-free `currentModelId` can differ from what a
    // session runs, so Grok, like the rest, learns it from a chat with no pick.
    expect([...listingNamesConfiguredModel].sort()).toEqual(['codex'])
  })

  it('maps an ACP agent with no session-free listing to an unavailable registration', () => {
    const spec = acpLaunchSpecFor('grok')!
    const discovery = acpModelCatalogDiscovery(
      { ...spec, modelDiscovery: { kind: 'unavailable', reason: 'no listing without a session' } },
      context()
    )
    expect(discovery).toEqual({ kind: 'unavailable', reason: 'no listing without a session' })
  })

  it('lists through the command each agent is set to run, never a bare name', async () => {
    const rig = mkdtempSync(join(tmpdir(), 'orca-catalog-overrides-'))
    const home = join(rig, 'home')
    const standIn = (agent: string): string => join(rig, `${agent}-standin`)
    for (const agent of ['claude', 'codex', 'grok']) {
      // Never run: the spawn is mocked; the override must only be a runnable file.
      writeFileSync(standIn(agent), '#!/bin/sh\nexit 1\n')
      chmodSync(standIn(agent), 0o755)
    }
    const settings = {
      agentCmdOverrides: {
        claude: standIn('claude'),
        codex: standIn('codex'),
        grok: standIn('grok')
      }
    }
    const env = async () => ({ PATH: '/usr/bin' })
    const { probes } = registeredModelCatalogDiscovery(STRUCTURED_AGENT_RUNTIME_REGISTRATIONS, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a probe reads only the command, env and auth resolvers given here.
      deps: {
        stateDirectory: '/state',
        resolveClaudeCommand: () => resolveStructuredAgentCommand('claude', settings),
        resolveCodexCommand: (options) => resolveStructuredAgentCommand('codex', settings, options),
        resolveClaudeAuthPolicy: () => ({ stripAuthEnv: false }),
        resolveAgentCommandSettings: () => settings
      } as StructuredAgentModelCatalogContext['deps'],
      environment: {
        resolveBaseEnvironment: env,
        resolveCodexEnvironment: env,
        resolveClaudeInheritedEnv: env
      }
    })
    const variables = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME' }
    for (const [agent, variable] of Object.entries(variables)) {
      spawned.commands.length = 0
      await expect(probes[agent]!({ variable, path: home })).rejects.toThrow()
      expect(spawned.commands, agent).toEqual([standIn(agent)])
    }
    rmSync(rig, { recursive: true, force: true })
  })
})
