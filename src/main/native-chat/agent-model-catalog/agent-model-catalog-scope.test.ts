import { describe, expect, it } from 'vitest'
import { createClaudeModelCatalogProbe } from '../../claude/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../../codex/codex-model-catalog-probe'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'

describe('installed catalog invocation identity', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps %s scope stable across shell captures while distinguishing launch inputs',
    async (agent) => {
      let capture = 'first'
      let catalogFile = '/catalog/A.json'
      const overlay = () => ({ CATALOG_FILE: catalogFile })
      let command = '/installed/agent'
      const launchArgs = (name: string) =>
        agent === 'claude'
          ? ['--settings', JSON.stringify({ model: name })]
          : ['--config', `model_provider="${name}"`]
      let args = launchArgs('work')
      const environment = () => ({ SSH_AUTH_SOCK: `/ssh/${capture}`, SSH_AGENT_PID: capture })
      const probe =
        agent === 'claude'
          ? createClaudeModelCatalogProbe({
              resolveCommand: () => command,
              resolveInheritedEnv: async () => environment(),
              resolveEnv: overlay,
              resolveAuthPolicy: () => ({ account: 'system' }),
              resolveLaunchArgs: () => args
            })
          : createCodexModelCatalogProbe({
              resolveCommand: () => command,
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
