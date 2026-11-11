import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import { AcpSessionRuntime } from '../protocol/acp-session-runtime'
import { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import { openCodeAcpAccountBinding } from '../../opencode/opencode-structured-account-home'
import { AcpAgentExitedError } from '../transport/acp-errors'
// Real `omp acp` 18.17.0 session/new replies: started on its default fake/wide, with
// `--model fake/narrow`, and with `--model fake/gone`, which it cannot resolve.
import recorded from '../fixtures/omp-v18.17.0-model-efforts.json'

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

async function listOmp(selectedModels?: string[]) {
  const agent = new AcpScriptedAgent()
  agents.push(agent)
  let launchedModel: string | undefined
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) =>
    agent.reply(frame, {
      sessionId: 'probe-session',
      ...(launchedModel === 'fake/narrow'
        ? recorded.narrow
        : launchedModel === 'fake/gone'
          ? recorded.unresolved
          : recorded.new)
    })
  )
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-omp-efforts-'))
  try {
    const listing = await createAcpModelCatalogProbe(acpLaunchSpecFor('omp')!, {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: () => '/opt/omp/bin/omp',
      probeVersion: async () => ({ version: '18.17.0' }),
      homePath: '/home/user',
      dataDirectory,
      connectSession: (launch) => {
        const at = launch.args.indexOf('--model')
        launchedModel = at === -1 ? undefined : launch.args[at + 1]
        if (launchedModel?.includes(':')) {
          // OMP 18.17.0 prints `Model "fake/gone:high" not found.` and exits 1 before ACP starts.
          const exited = async () => {
            throw new AcpAgentExitedError('Model "fake/gone:high" not found.')
          }
          return {
            initialize: exited,
            start: exited,
            setConfigOption: exited,
            deleteSession: exited,
            close: async () => {}
          }
        }
        const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
        return {
          initialize: () => runtime.initialize(),
          start: (options) => runtime.start(options),
          setConfigOption: (id, value) => runtime.setConfigOption(id, value),
          deleteSession: (sessionId) => runtime.deleteSession(sessionId),
          close: async () => runtime.close()
        }
      }
    })(
      { variable: 'PI_CODING_AGENT_DIR', path: '/homes/omp' },
      { workspacePath: '/work/project', ...(selectedModels ? { selectedModels } : {}) }
    )
    // A model switch would record usage in the user's OMP account.
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
    return (id: string) => listing.models.find((model) => model.id === id)
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

const levels = (model: { efforts: { value: string }[] } | undefined) =>
  model?.efforts.map((effort) => effort.value)

it("lists a picked OMP model with its own thinking levels, not the startup model's", async () => {
  const listed = await listOmp()
  expect(levels(listed('fake/wide'))).toEqual([
    'off',
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
  ])
  expect(listed('fake/narrow')).toMatchObject({ efforts: [], effortsKnown: false })

  const picked = await listOmp(['fake/narrow'])
  expect(levels(picked('fake/narrow'))).toEqual(['off', 'auto', 'low', 'high'])
  expect(picked('fake/narrow')).not.toHaveProperty('effortsKnown')
  expect(picked('fake/wide')).toMatchObject({ efforts: [], effortsKnown: false })
})

it('trusts no menu when OMP cannot start on the picked model', async () => {
  const picked = await listOmp(['fake/gone'])
  expect(picked('fake/wide')).toMatchObject({ efforts: [], effortsKnown: false })
})

it('still lists OMP when it cannot start on the picked model', async () => {
  const picked = await listOmp(['fake/gone:high'])
  expect(levels(picked('fake/wide'))).toEqual([
    'off',
    'auto',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh'
  ])
})
