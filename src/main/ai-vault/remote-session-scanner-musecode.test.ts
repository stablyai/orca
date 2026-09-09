import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

describe('scanRemoteAiVaultSessions musecode', () => {
  it('discovers MuseCode transcripts under the remote XDG sessions root', async () => {
    const provider = new MemoryRemoteProvider()
    const sessionDir = '/home/ada/.local/share/muse/sessions/2026/07/04/musecode-remote'
    provider.addFile(
      `${sessionDir}/session.jsonl`,
      jsonLines([
        {
          record_type: 'event',
          payload_type: 'runtime.session.metadata',
          recorded_at: 1780000000000000,
          payload: { kind: 'metadata', record: { workspace_root: '/home/ada/repo' } }
        },
        {
          record_type: 'event',
          payload_type: 'runtime.user_intent.accepted',
          recorded_at: 1780000001000000,
          payload: {
            intent_id: 'intent-remote',
            refill_blocks: [{ kind: 'text', text: 'Remote musecode title' }]
          }
        },
        {
          record_type: 'event',
          payload_type: 'runtime.session',
          recorded_at: 1780000002000000,
          payload: {
            kind: 'run',
            run_id: 'run-remote',
            event: {
              kind: 'model_completed',
              model: 'muse-spark-remote',
              usage: { input_tokens: 3, output_tokens: 4 }
            }
          }
        }
      ]),
      40
    )
    // Sidecars next to the transcript must not list as sessions.
    provider.addFile(`${sessionDir}/cli-abc.log`, 'log output', 41)

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      executionHostPlatform: 'linux',
      agent: 'musecode',
      sessionId: 'musecode-remote',
      title: 'Remote musecode title',
      model: 'muse-spark-remote',
      filePath: `${sessionDir}/session.jsonl`
    })
  })
})
