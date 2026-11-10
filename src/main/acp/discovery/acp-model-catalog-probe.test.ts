import { afterEach, describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import { AcpSessionRuntime } from '../protocol/acp-session-runtime'
import { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import { openCodeAcpAccountBinding } from '../../opencode/opencode-structured-account-home'

// Bypass the app's managed-account service for this fixture.
const OPENCODE: AcpLaunchSpec = {
  ...acpLaunchSpecFor('opencode')!,
  account: openCodeAcpAccountBinding(() => ({
    list: () => ({ activeAccountId: null, accounts: [] }),
    restoreOriginalEnvironment: () => {},
    environmentForAccount: () => ({})
  }))
}

const agents: AcpScriptedAgent[] = []
afterEach(() => {
  for (const agent of agents.splice(0)) {
    agent.close()
  }
})

describe('ACP model catalog probes', () => {
  it('lists the catalog after OpenCode answers session/new with -32603 while starting', async () => {
    const agent = new AcpScriptedAgent()
    agents.push(agent)
    agent.on('initialize', (frame) =>
      agent.reply(frame, {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { delete: {} } }
      })
    )
    let sessionNews = 0
    agent.on('session/new', (frame) => {
      sessionNews += 1
      if (sessionNews === 1) {
        agent.fail(frame, -32603, 'Internal error: Internal service failure', {
          errorName: 'InvalidRequestError'
        })
        return
      }
      agent.reply(frame, {
        sessionId: 'probe-session',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'opencode/exo-free',
            options: [
              { value: 'opencode/big-pickle', name: 'Big Pickle' },
              { value: 'opencode/exo-free', name: 'Exo Free' }
            ]
          }
        ]
      })
    })
    agent.on('session/delete', (frame) => agent.reply(frame, {}))
    agent.on('session/set_config_option', (frame) => agent.fail(frame, -32602, 'Model unavailable'))

    const success = await createAcpModelCatalogProbe(OPENCODE, {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => ({ version: '2.0.29' }),
      homePath: '/home/user',
      dataDirectory: '/orca-data',
      connectSession: () => {
        const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
        return {
          initialize: () => runtime.initialize(),
          start: (options) => runtime.start(options),
          setConfigOption: (id, value) => runtime.setConfigOption(id, value),
          deleteSession: (sessionId) => runtime.deleteSession(sessionId),
          close: async () => runtime.close()
        }
      }
    })({ kind: 'opencode', locator: { kind: 'unmanaged' } }, { workspacePath: '/work/project' })

    expect(sessionNews).toBe(2)
    expect(success.models.map((model) => model.id)).toEqual([
      'opencode/big-pickle',
      'opencode/exo-free'
    ])
  })
})
