import { describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { prepareAdoptedTranscript } from './structured-agent-session-adopted-import'

function params(agent: string, transcriptPath: string): AgentSessionAttachParams {
  return {
    envelope: {
      sessionId: 'session-1',
      clientOperationId: 'operation-1',
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: agent,
    agent,
    accountHome: { variable: 'XDG_DATA_HOME', path: '/data/home' },
    runtimeKind: 'native',
    adopt: {
      providerHandle: codexProviderHandle('session-one'),
      transcriptPath,
      source: { providerSessionId: 'session-one', workspaceCwd: '/workspace' }
    }
  }
}

describe('prepareAdoptedTranscript', () => {
  it('skips transcript decoding when the agent replays history itself', async () => {
    // Devin has a transcript file for evidence but no decoder; session/load replays instead.
    const prepared = await prepareAdoptedTranscript(params('devin', '/absent/transcript.json'))
    expect(prepared).toEqual({ ok: true, items: null })
  })

  it('still refuses a decoding agent whose transcript cannot be imported', async () => {
    const prepared = await prepareAdoptedTranscript(params('codex', '/absent/rollout.jsonl'))
    expect(prepared.ok).toBe(false)
  })
})
