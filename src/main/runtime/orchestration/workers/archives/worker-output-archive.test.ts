import { describe, expect, it } from 'vitest'
import { deriveWorkerOutputReferenceFromSavedState } from './worker-output-archive'

function savedSession(transcriptPath?: string): string {
  return JSON.stringify({
    agent: 'claude',
    providerSession: {
      key: 'session_id',
      id: 'claude-session-1',
      ...(transcriptPath ? { transcriptPath } : {})
    },
    connectionId: null
  })
}

const wsl = JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu-B' })
const local = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('output reference for a worker whose process is gone', () => {
  it('pins a WSL transcript to the distro the pane recorded', () => {
    expect(
      deriveWorkerOutputReferenceFromSavedState({
        resource: {
          host_scope: wsl,
          resume_session: savedSession('/home/u/.claude/projects/p/claude-session-1.jsonl')
        },
        platform: 'win32'
      })
    ).toMatchObject({
      kind: 'transcript_pin',
      status: 'captured',
      content: { sessionId: 'claude-session-1', wslDistro: 'Ubuntu-B' }
    })
  })

  it.each([
    ['a WSL session saved without its transcript path', wsl, undefined],
    ['a guest path saved against a native Windows pane', local, '/home/u/.claude/p/s.jsonl'],
    ['a native Windows session saved without its transcript path', local, undefined]
  ])(
    'records %s as unavailable instead of a reference no reader can open',
    (_case, scope, saved) => {
      expect(
        deriveWorkerOutputReferenceFromSavedState({
          resource: { host_scope: scope, resume_session: savedSession(saved) },
          platform: 'win32'
        })
      ).toEqual({
        kind: 'terminal_tail',
        status: 'unavailable',
        content: { version: 3, fallbackReason: 'remote_capability_unavailable' }
      })
    }
  )

  it('points a stopped chat worker at its journal, not at terminal output', () => {
    expect(
      deriveWorkerOutputReferenceFromSavedState({
        resource: { host_scope: local, resume_session: null },
        structuredWorker: {
          handle: 'structured-worker-1',
          sessionId: 'chat-session-1',
          agent: 'codex',
          paneKey: 'tab_chat:leaf',
          processIncarnation: 'structured:chat-session-1',
          worktreeId: 'repo::wt',
          hostScope: { kind: 'local', hostId: 'local' }
        }
      })
    ).toEqual({
      kind: 'structured_journal',
      status: 'captured',
      content: { version: 3, agent: 'codex', processIncarnation: 'structured:chat-session-1' }
    })
  })
})
