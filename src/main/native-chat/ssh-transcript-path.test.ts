import { describe, expect, it } from 'vitest'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import {
  nativeChatTranscriptPathOnExecutionHost,
  parseSshTranscriptPath,
  toSshTranscriptPath
} from './ssh-transcript-path'

const REMOTE_PATH = '/home/ada/.claude/projects/p/session-1.jsonl'
// A colon, so the encoding is shown to keep the id separate from the path.
const CONNECTION_ID = 'target:1'

function row(connectionId: string | null, transcriptPath = REMOTE_PATH) {
  return {
    connectionId,
    providerSession: { key: 'session_id' as const, id: 'session-1', transcriptPath }
  }
}

function readsFrom(path: string | undefined) {
  return path ? (parseSshTranscriptPath(path) ?? path) : path
}

describe('nativeChatTranscriptPathOnExecutionHost', () => {
  it('names the SSH host the hook store attests the session to', () => {
    expect(
      readsFrom(
        nativeChatTranscriptPathOnExecutionHost([row(CONNECTION_ID)], 'session-1', REMOTE_PATH)
      )
    ).toEqual({ connectionId: CONNECTION_ID, remotePath: REMOTE_PATH })
  })

  it('leaves local and WSL sessions on this machine', () => {
    const wsl = wslHookRelayConnectionId('Ubuntu')

    expect(nativeChatTranscriptPathOnExecutionHost([row(null)], 'session-1', REMOTE_PATH)).toBe(
      REMOTE_PATH
    )
    expect(nativeChatTranscriptPathOnExecutionHost([row(wsl)], 'session-1', REMOTE_PATH)).toBe(
      REMOTE_PATH
    )
  })

  it('reads an SSH session on its host even when the client asks for another path', () => {
    expect(
      readsFrom(
        nativeChatTranscriptPathOnExecutionHost(
          [row(CONNECTION_ID)],
          'session-1',
          '/tmp/stale.jsonl'
        )
      )
    ).toEqual({ connectionId: CONNECTION_ID, remotePath: REMOTE_PATH })
  })

  it('prefers the SSH row whose transcript the client asked for', () => {
    const rows = [row(CONNECTION_ID), row('target:2', '/home/ada/other.jsonl')]

    expect(
      readsFrom(nativeChatTranscriptPathOnExecutionHost(rows, 'session-1', '/home/ada/other.jsonl'))
    ).toEqual({ connectionId: 'target:2', remotePath: '/home/ada/other.jsonl' })
  })

  it('keeps a session on this machine when a local row attests the requested path', () => {
    const localPath = '/home/bob/.claude/projects/p/session-1.jsonl'
    const rows = [row(CONNECTION_ID), row(null, localPath)]

    expect(nativeChatTranscriptPathOnExecutionHost(rows, 'session-1', localPath)).toBe(localPath)
  })

  it('ignores an SSH-qualified path a client sends itself', () => {
    const forged = toSshTranscriptPath(CONNECTION_ID, '/etc/secret.jsonl')

    expect(nativeChatTranscriptPathOnExecutionHost([], 'session-1', forged)).toBeUndefined()
  })
})
