import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { acpLaunchSpecFor } from './acp-launch-registry'

let dataDirectory = ''
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'acp-launch-model-'))
})
afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true })
})

function launchOmp(record: Partial<AgentSessionRecord>) {
  const full: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: 'omp',
    providerHandleChain: [],
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
    ...record
  }
  const resolve = createAcpStructuredLaunchResolver(acpLaunchSpecFor('omp')!, {
    store: { getRecord: () => full, pinLaunchDirectory: vi.fn() },
    savedSession: { hasProviderTurn: async () => false },
    resolveWorkspacePath: async () => '/home/user/project',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => ({}),
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    dataDirectory,
    probeVersion: async () => ({ version: '17.2.9' })
  })
  return resolve({
    identity: {
      sessionId: 'session-omp',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'omp',
      providerHandle: null
    }
  })
}

describe('ACP launch: the saved model', () => {
  it('starts a new OMP chat on it', async () => {
    const resolved = await launchOmp({ options: { model: 'anthropic/claude-sonnet' } })
    expect(resolved.args).toContain('--model')
    expect(resolved.args).toContain('anthropic/claude-sonnet')
  })

  // OMP's load restores the session's own model; only a spec with reopensWithModel passes it again.
  it('leaves it to OMP’s load when the chat reopens its conversation', async () => {
    const resolved = await launchOmp({
      options: { model: 'anthropic/claude-sonnet' },
      providerHandleChain: [
        {
          linkId: 'link-1',
          handle: { transport: 'acp', agent: 'omp', nativeId: 'omp-session-1' },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        }
      ]
    })
    expect(resolved.args).not.toContain('--model')
    expect(resolved.args).not.toContain('anthropic/claude-sonnet')
  })
})
