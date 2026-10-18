import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
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
      resolveAgentEnvironment: unused,
      refreshAfterMissingProgram: unused
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
    // Every agent registered today but OMP and Antigravity lists its models without a session.
    expect(listing.sort()).toEqual(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map((registration) => registration.definition.agent)
        .filter((agent) => agent !== 'omp' && agent !== 'antigravity')
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

  // OpenCode 2.x lists in a session opened in the chat's folder, which a prewarm does not have.
  it('marks the agents whose listing runs in a chat folder', () => {
    const { listsInChatFolder } = registeredModelCatalogDiscovery(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      context()
    )
    expect([...listsInChatFolder].sort()).toEqual(['opencode', 'opencode2'])
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
        resolveClaudeAuthPolicy: () => ({ account: 'system' as const }),
        resolveAgentCommandSettings: () => settings
      } as StructuredAgentModelCatalogContext['deps'],
      environment: {
        resolveBaseEnvironment: env,
        resolveAgentEnvironment: env,
        refreshAfterMissingProgram: async () => {}
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

  it.skipIf(process.platform === 'win32')(
    'rereads the environment once, as a launch does, for a program installed since it was read',
    async () => {
      const rig = mkdtempSync(join(tmpdir(), 'orca-catalog-installed-'))
      // Names only the reread PATH has, so nothing on the machine running the test answers.
      const installed = (agent: string): string => `${agent}-installed-${process.pid}`
      const agents = {
        claude: 'CLAUDE_CONFIG_DIR',
        codex: 'CODEX_HOME',
        grok: 'GROK_HOME',
        pi: 'PI_CODING_AGENT_DIR'
      }
      for (const agent of Object.keys(agents)) {
        writeFileSync(join(rig, installed(agent)), '#!/bin/sh\nexit 1\n')
        chmodSync(join(rig, installed(agent)), 0o755)
      }
      let served = '/usr/bin'
      const env = async () => ({ PATH: served, HOME: join(rig, 'home') })
      const refresh = vi.fn(async () => {
        served = rig
      })
      const settings = { agentCmdOverrides: { grok: installed('grok'), pi: installed('pi') } }
      const { probes } = registeredModelCatalogDiscovery(STRUCTURED_AGENT_RUNTIME_REGISTRATIONS, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a probe reads only the command, env and auth resolvers given here.
        deps: {
          stateDirectory: '/state',
          resolveClaudeCommand: (options) => resolveCliCommand(installed('claude'), options),
          resolveCodexCommand: (options) => resolveCliCommand(installed('codex'), options),
          resolveClaudeAuthPolicy: () => ({ account: 'system' as const }),
          resolveAgentCommandSettings: () => settings
        } as StructuredAgentModelCatalogContext['deps'],
        environment: {
          resolveBaseEnvironment: env,
          resolveAgentEnvironment: env,
          refreshAfterMissingProgram: refresh
        }
      })
      for (const [agent, variable] of Object.entries(agents)) {
        served = '/usr/bin'
        spawned.commands.length = 0
        await expect(probes[agent]!({ variable, path: join(rig, 'home') })).rejects.toThrow()
        expect(spawned.commands, agent).toEqual([join(rig, installed(agent))])
      }
      expect(refresh).toHaveBeenCalledTimes(4)
      rmSync(rig, { recursive: true, force: true })
    }
  )
})
