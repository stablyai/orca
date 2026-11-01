import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveCliCommand } from '../../../shared/node-cli-command-resolution'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { createClaudeModelCatalogProbe } from '../../claude/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../../codex/codex-model-catalog-probe'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import { AgentModelCatalogProbeError } from './agent-model-catalog-probe-runner'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

describe('installed catalog invocation identity', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps %s scope stable across shell captures while distinguishing launch inputs',
    async (agent) => {
      let capture = 'first'
      let catalogFile = '/catalog/A.json'
      const overlay = () => ({ CATALOG_FILE: catalogFile })
      let command = '/installed/agent'
      let prefixArgs: string[] = []
      const launchArgs = (name: string) =>
        agent === 'claude'
          ? ['--settings', JSON.stringify({ model: name })]
          : ['--config', `model_provider="${name}"`]
      let args = launchArgs('work')
      const environment = () => ({ SSH_AUTH_SOCK: `/ssh/${capture}`, SSH_AGENT_PID: capture })
      const probe =
        agent === 'claude'
          ? createClaudeModelCatalogProbe({
              resolveCommand: () => ({ command, prefixArgs }),
              resolveInheritedEnv: async () => environment(),
              resolveEnv: overlay,
              resolveAuthPolicy: () => ({ account: 'system' }),
              resolveLaunchArgs: () => args
            })
          : createCodexModelCatalogProbe({
              resolveCommand: () => ({ command, prefixArgs }),
              resolveEnvironment: async () => environment(),
              resolveEnv: overlay,
              resolveLaunchArgs: () => args
            })
      const key = async (account = '/account', cwd = '/project') => {
        const home = {
          variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
          path: account
        }
        const resolved = await probe.resolve?.(home, cwd)
        expect(resolved).toBeDefined()
        const base = agentModelCatalogFingerprint({ agent, accountHome: home, wslDistro: null })
        return agentModelCatalogScopeFingerprint(base, cwd, resolved?.identity)
      }
      const first = await key()
      prefixArgs = ['run', '--', agent]
      expect(await key()).not.toBe(first)
      prefixArgs = []
      capture = 'second'
      expect(await key()).toBe(first)
      catalogFile = '/catalog/B.json'
      expect(await key()).not.toBe(first)
      catalogFile = '/catalog/A.json'
      expect(await key()).toBe(first)
      expect(await key('/other-account')).not.toBe(first)
      expect(await key('/account', '/other-project')).not.toBe(first)
      command = '/other/agent'
      expect(await key()).not.toBe(first)
      command = '/installed/agent'
      args = launchArgs('personal')
      expect(await key()).not.toBe(first)
    }
  )
})

describe('original operation through actual nested resolution', () => {
  it.each(['overlay', 'environment', 'auth'] as const)(
    'starts no stage after %s resolves beyond the original deadline',
    async (held) => {
      vi.useFakeTimers()
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const stages: string[] = []
      const stage = async (name: string) => {
        stages.push(name)
        if (name === held) {
          entered.resolve()
          await gate.promise
        }
      }
      const runListing = vi.fn(async () => '')
      const probe = createClaudeModelCatalogProbe({
        resolveLaunchArgs: () => [],
        resolveEnv: async () => {
          await stage('overlay')
          return {}
        },
        resolveInheritedEnv: async () => {
          await stage('environment')
          return { PATH: '/fixture' }
        },
        resolveCommand: () => {
          stages.push('lookup')
          return { command: '/fixture/claude', prefixArgs: [] }
        },
        resolveAuthPolicy: async () => {
          await stage('auth')
          return { account: 'system' }
        },
        runListing
      })
      const record = agentSessionRecordFixture({
        sessionId: 'catalog-scope-session',
        provider: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fixture/account' }
      })
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => {
          const held = record
          return held ? agentSessionConversationView(held) : undefined
        },
        getRecord: () => record,
        drivesRecord: () => true,
        resolveAccountHome: async () => record.accountHome,
        recordWorkspacePath: async () => '/fixture/workspace',
        probes: { claude: probe }
      })
      try {
        const demand = service.demand({
          agent: 'claude',
          sessionId: record.sessionId,
          deadline: Date.now() + 10
        })
        await entered.promise
        const before = [...stages]
        await vi.advanceTimersByTimeAsync(11)
        await demand
        gate.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(stages).toEqual(before)
        expect(runListing).not.toHaveBeenCalled()
        expect(service.snapshot({ agent: 'claude', sessionId: record.sessionId })).toEqual({
          origin: 'unknown'
        })
      } finally {
        gate.resolve()
        service.stop()
        vi.useRealTimers()
      }
    }
  )
})

describe('a picker read with the CLI missing', () => {
  it('waits on at most one shell rerun per hold window, and finds a CLI installed after it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-catalog-missing-cli-'))
    try {
      const name = `claude-missing-${process.pid}`
      const profileBin = join(root, 'profile-bin')
      mkdirSync(profileBin)
      const program = join(profileBin, process.platform === 'win32' ? `${name}.cmd` : name)
      writeFileSync(program, '#!/bin/sh\nexit 0\n')
      chmodSync(program, 0o755)
      let served = '/usr/bin'
      const reruns = vi.fn(async (_askedAt: number) => {})
      const runListing = vi.fn(async (launch: { command: string }) => {
        if (launch.command !== program) {
          throw new AgentModelCatalogProbeError('spawn ENOENT', 'spawn', true)
        }
        return `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'orca-model-discovery',
            response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
          }
        })}\n`
      })
      let now = 1_000
      const service = createAgentModelCatalogService({
        store: new AgentModelCatalogStore({ now: () => now }),
        getConversation: () => undefined,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: root }),
        probes: {
          claude: createClaudeModelCatalogProbe({
            resolveCommand: (options) => ({
              command: resolveCliCommand(name, options),
              prefixArgs: []
            }),
            resolveInheritedEnv: async () => ({ PATH: served, HOME: root }),
            refreshEnvironmentAfterMiss: reruns,
            resolveAuthPolicy: () => ({ account: 'system' }),
            runListing
          })
        }
      })
      const read = () =>
        service.read({ agent: 'claude', workspacePath: root, waitForListing: true })

      expect(await read()).toMatchObject({ unavailable: { reason: 'cliMissing' } })
      for (let i = 0; i < 3; i++) {
        expect(await read()).toMatchObject({ unavailable: { reason: 'cliMissing' } })
      }
      expect(reruns).toHaveBeenCalledOnce()

      reruns.mockImplementation(async () => {
        served = profileBin
      })
      now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
      const found = await read()
      expect(found).toMatchObject({ models: [{ id: 'sonnet' }] })
      expect(found).not.toHaveProperty('unavailable')
      expect(reruns).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
