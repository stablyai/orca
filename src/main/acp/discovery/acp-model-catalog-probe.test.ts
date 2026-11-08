import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from './acp-model-catalog-probe'
import { AcpSessionRuntime } from '../protocol/acp-session-runtime'
import { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { openCodeAcpAccountBinding } from '../../opencode/opencode-structured-account-home'
import recordedEfforts from '../fixtures/opencode-v2.0.21-model-efforts.json'
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
  vi.restoreAllMocks()
  for (const agent of agents.splice(0)) {
    agent.close()
  }
})

function scriptedOpenCode2(canDelete: boolean): {
  agent: AcpScriptedAgent
  launches: ProviderProcessLaunch[]
  closed: () => number
  deps: AcpModelCatalogProbeDeps & {
    runListing: Mock<NonNullable<AcpModelCatalogProbeDeps['runListing']>>
  }
} {
  const agent = new AcpScriptedAgent()
  agents.push(agent)
  agent.on('initialize', (frame) =>
    agent.reply(frame, {
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: canDelete ? { delete: {} } : {}
      }
    })
  )
  agent.on('session/new', (frame) =>
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
  )
  agent.on('session/delete', (frame) => agent.reply(frame, {}))
  agent.on('session/set_config_option', (frame) => agent.fail(frame, -32602, 'Model unavailable'))
  const launches: ProviderProcessLaunch[] = []
  let closes = 0
  return {
    agent,
    launches,
    closed: () => closes,
    deps: {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => ({ version: '2.0.29' }),
      homePath: '/home/user',
      dataDirectory: '/orca-data',
      runListing: vi.fn<NonNullable<AcpModelCatalogProbeDeps['runListing']>>(),
      connectSession: (launch) => {
        launches.push(launch)
        const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
        return {
          initialize: () => runtime.initialize(),
          start: (options) => runtime.start(options),
          setConfigOption: (id, value) => runtime.setConfigOption(id, value),
          deleteSession: (sessionId) => runtime.deleteSession(sessionId),
          close: async () => {
            closes += 1
            runtime.close()
          }
        }
      }
    }
  }
}

describe('ACP model catalog probes', () => {
  it('deletes a session before closing when cancelled during effort discovery', async () => {
    vi.useFakeTimers()
    try {
      const { agent, deps, closed } = scriptedOpenCode2(true)
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: 'probe-session', ...recordedEfforts.new })
      )
      agent.on('session/set_config_option', () => {})
      agent.on('session/delete', (frame) => {
        expect(closed()).toBe(0)
        agent.reply(frame, {})
      })
      const stop = new AbortController()
      const listing = createAcpModelCatalogProbe(OPENCODE, deps)(
        { kind: 'opencode', locator: { kind: 'unmanaged' } },
        { workspacePath: '/work/project', signal: stop.signal }
      )
      const rejected = expect(listing).rejects.toThrow(/listing stopped/)
      await vi.waitFor(() =>
        expect(agent.frames.map((frame) => frame.method)).toContain('session/set_config_option')
      )
      stop.abort()
      await rejected
      expect(agent.frames.at(-1)?.method).toBe('session/delete')
      expect(closed()).toBe(1)
      await vi.runAllTimersAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists OMP from a session kept in a folder it removes, in the chat folder', async () => {
    const { agent, deps, launches } = scriptedOpenCode2(false)
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-omp-listing-'))
    try {
      const success = await createAcpModelCatalogProbe(acpLaunchSpecFor('omp')!, {
        ...deps,
        dataDirectory,
        resolveCommand: () => '/opt/omp/bin/omp',
        probeVersion: async () => ({ version: '18.12.2' })
      })(
        { variable: 'PI_CODING_AGENT_DIR', path: '/homes/omp' },
        { workspacePath: '/work/project' }
      )
      expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
      expect(agent.frames[1]!.params).toMatchObject({ cwd: '/work/project' })
      const root = join(dataDirectory, 'acp-listing-sessions', 'omp')
      expect(launches).toEqual([
        expect.objectContaining({
          args: ['acp', '--session-dir', expect.stringMatching(/run-/)]
        })
      ])
      expect(dirname(launches[0]!.args[2]!)).toBe(root)
      expect(await readdir(root)).toEqual([])
      expect(success.models.map((model) => model.id)).toEqual([
        'opencode/big-pickle',
        'opencode/exo-free'
      ])
    } finally {
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  // An interrupted create can save a session without returning its ID.
  it('stops a listing cut off while OpenCode 2.x creates its session, without deleting', async () => {
    const { agent, deps, closed } = scriptedOpenCode2(true)
    agent.on('session/new', () => {})
    const stop = new AbortController()
    const listing = createAcpModelCatalogProbe(OPENCODE, deps)(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      { workspacePath: '/work/project', signal: stop.signal }
    )
    await vi.waitFor(() =>
      expect(agent.frames.map((frame) => frame.method)).toContain('session/new')
    )
    stop.abort()
    await expect(listing).rejects.toThrow(/listing stopped/)
    expect(closed()).toBe(1)
    expect(agent.frames.map((frame) => frame.method)).not.toContain('session/delete')
  })
})
