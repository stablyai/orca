import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from './methods'
import { buildRegistry } from './core'
import { ACCOUNT_METHODS } from './methods/accounts'
import { resolveOrcadFeatureRequirement, type OrcadFeature } from './orcad-feature-readiness'

// Every method's declared needs for these params; param-level ones read them.
const REGISTRY = buildRegistry(ALL_RPC_METHODS)
const requiresOf = (name: string, params: unknown = {}): readonly OrcadFeature[] => {
  const method = REGISTRY.get(name)
  expect(method, name).toBeDefined()
  return resolveOrcadFeatureRequirement(method?.requires, params)
}

// Launches that start an agent (and so read its account home); a terminal create is one only with an agent.
const AGENT_LAUNCHES = [
  'terminal.createAgentSession',
  'agentSession.create',
  'git.generateCommitMessage',
  'orchestration.workerStart',
  'orchestration.federationAttachStart'
]
const PARAM_GATED_LAUNCHES = [
  'terminal.ensureAgentSession',
  'terminal.create',
  'session.tabs.createTerminal',
  'agent.launch',
  'agent.launchReplay'
]

describe('which RPC methods wait for an orcad startup phase', () => {
  it('gates the account services, search index, orchestration and orphan adoption', () => {
    for (const method of ALL_RPC_METHODS) {
      const expected: OrcadFeature[] = []
      // Claude/Codex account services only; usage credentials and Antigravity live elsewhere.
      if (
        ACCOUNT_METHODS.some((account) => account.name === method.name) &&
        method.name !== 'accounts.setHostLaunchEnv' &&
        method.name !== 'accounts.unsubscribe'
      ) {
        expected.push('accounts')
      }
      if (AGENT_LAUNCHES.includes(method.name)) {
        expected.push('accounts')
      }
      if (method.name.startsWith('orchestration.')) {
        expected.push('orchestration')
      }
      if (/^aiVault\.(searchSessions|searchStatus|setSearchEnabled)$/.test(method.name)) {
        expected.push('sessionSearch')
      }
      if (method.name === 'terminal.adoptOrphans') {
        expected.push('unshownPlacement')
      }
      if (PARAM_GATED_LAUNCHES.includes(method.name)) {
        expect(typeof method.requires, method.name).toBe('function')
        continue
      }
      expect({ name: method.name, requires: requiresOf(method.name) }).toEqual({
        name: method.name,
        requires: expected
      })
    }
  })

  it('gates a terminal create only when it starts an agent; plain shells stay ungated', () => {
    for (const name of ['terminal.create', 'session.tabs.createTerminal']) {
      expect(requiresOf(name, {}), name).toEqual([])
      expect(requiresOf(name, { command: 'ls -la' }), name).toEqual([])
      expect(requiresOf(name, { command: 'claude --resume' }), name).toEqual(['accounts'])
      expect(requiresOf(name, { command: 'codex' }), name).toEqual(['accounts'])
      expect(requiresOf(name, { launchAgent: 'claude' }), name).toEqual(['accounts'])
      expect(requiresOf(name, { launchConfig: { agentArgs: '', agentEnv: {} } }), name).toEqual([
        'accounts'
      ])
      expect(requiresOf(name, { resumeProviderSession: { id: 's' } }), name).toEqual(['accounts'])
    }
    expect(requiresOf('session.tabs.createTerminal', { agent: 'claude' })).toEqual(['accounts'])
  })

  it('gates only an explicit ensureAgentSession; an attach is restore latency', () => {
    expect(requiresOf('terminal.ensureAgentSession', { kind: 'explicit' })).toEqual(['accounts'])
    expect(requiresOf('terminal.ensureAgentSession', { kind: 'automatic' })).toEqual([])
  })

  it('gates agent.launch unless it reuses a live terminal', () => {
    for (const name of ['agent.launch', 'agent.launchReplay']) {
      expect(requiresOf(name, {}), name).toEqual(['accounts'])
      expect(requiresOf(name, { reuseTerminal: { handle: 'h' } }), name).toEqual([])
    }
  })

  it('never gates what every client calls at connect', () => {
    for (const name of [
      'status.get',
      'repo.list',
      'session.tabs.subscribe',
      'terminal.list',
      'worktree.teardownMissingTerminals',
      'accounts.setHostLaunchEnv'
    ]) {
      expect(ALL_RPC_METHODS.some((method) => method.name === name)).toBe(true)
      expect(requiresOf(name)).toEqual([])
    }
  })

  // No behavior change yet: orcad opens every latch before RPC starts accepting calls.
  it('opens every latch before orcad starts RPC', () => {
    const read = (file: string): string =>
      readFileSync(join(__dirname, '../../orcad', file), 'utf8')
    const entry = read('orcad-entry.ts')
    const restore = read('orcad-restored-terminal-authority.ts')
    const rpcStart = entry.indexOf("await timed('rpc', () => rpc.start())")
    const restored = entry.indexOf('await restoreOrcadTerminalAuthority(')
    expect(rpcStart).toBeGreaterThan(0)
    expect(restored).toBeGreaterThan(0)
    expect(restored).toBeLessThan(rpcStart)
    for (const feature of ['accounts', 'sessionSearch']) {
      const opened = entry.indexOf(`featureReadiness.open('${feature}')`)
      expect(opened, feature).toBeGreaterThan(0)
      expect(opened, feature).toBeLessThan(rpcStart)
    }
    for (const feature of ['orchestration', 'unshownPlacement']) {
      expect(restore).toContain(`readiness.open('${feature}')`)
    }
  })
})
