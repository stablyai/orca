import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  writeOmpScannerFixture,
  writePrimeAgentScannerFixture
} from './session-scanner-test-fixtures'
import { jsonlBody, type AgentVaultRoots } from './session-scanner-vault-roots'

// The agents whose session is an append-only JSONL log the CLI writes a record
// at a time. Split from the document-shaped agents purely by file size; the two
// halves are called together and neither is meaningful alone.

/**
 * Write one append-only transcript per log-shaped agent.
 * @param roots - The scan roots to write under.
 * @returns The transcript paths OMP and Prime Agent resume by.
 */
export async function writeLogAgentFixtures(
  roots: AgentVaultRoots
): Promise<{ ompSessionFile: string; primeAgentSessionFile: string }> {
  await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })
  await writeFile(
    join(roots.claudeProjectsDir, 'project', 'claude-session.jsonl'),
    jsonlBody([
      {
        type: 'user',
        sessionId: 'claude-session',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'Claude title' }
      }
    ])
  )

  await mkdir(join(roots.codexSessionsDir, '2026', '05', '01'), { recursive: true })
  await writeFile(
    join(roots.codexSessionsDir, '2026', '05', '01', 'rollout-2026-codex-session.jsonl'),
    jsonlBody([
      {
        timestamp: '2026-05-01T10:01:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-session', cwd: '/tmp/codex' }
      },
      {
        timestamp: '2026-05-01T10:01:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Codex title' }]
        }
      }
    ])
  )

  await mkdir(roots.copilotSessionsDir, { recursive: true })
  await writeFile(
    join(roots.copilotSessionsDir, 'copilot-session.jsonl'),
    jsonlBody([
      {
        type: 'session.start',
        data: { sessionId: 'copilot-session', startTime: '2026-05-01T10:03:00.000Z' },
        timestamp: '2026-05-01T10:03:00.000Z'
      },
      {
        type: 'session.info',
        data: {
          infoType: 'folder_trust',
          message: 'Folder /tmp/copilot has been added to trusted folders.'
        },
        timestamp: '2026-05-01T10:03:01.000Z'
      },
      {
        type: 'user.message',
        data: { transformedContent: 'Copilot title' },
        timestamp: '2026-05-01T10:03:02.000Z'
      }
    ])
  )

  await mkdir(join(roots.cursorProjectsDir, 'project', 'agent-transcripts'), { recursive: true })
  await writeFile(
    join(roots.cursorProjectsDir, 'project', 'agent-transcripts', 'cursor-session.jsonl'),
    jsonlBody([
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'Cursor title' }] }
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
    ])
  )

  await mkdir(join(roots.openclawStateDir, 'agents', 'default', 'sessions'), { recursive: true })
  await writeFile(
    join(roots.openclawStateDir, 'agents', 'default', 'sessions', 'openclaw-session.jsonl'),
    jsonlBody([
      {
        type: 'session',
        id: 'openclaw-session',
        timestamp: '2026-05-01T10:07:00.000Z',
        cwd: '/tmp/openclaw'
      },
      {
        type: 'message',
        timestamp: '2026-05-01T10:07:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'OpenClaw title' }] }
      }
    ])
  )

  await mkdir(roots.piSessionsDir, { recursive: true })
  await writeFile(
    join(roots.piSessionsDir, 'pi-session.jsonl'),
    jsonlBody([
      {
        type: 'session',
        id: 'pi-session',
        timestamp: '2026-05-01T10:08:00.000Z',
        cwd: '/tmp/pi'
      },
      {
        type: 'message',
        timestamp: '2026-05-01T10:08:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Pi title' }] }
      }
    ])
  )

  const ompSessionFile = await writeOmpScannerFixture(roots.ompSessionsDir)
  const primeAgentSessionFile = await writePrimeAgentScannerFixture(roots.primeAgentSessionsDir)

  await mkdir(roots.droidSessionsDir, { recursive: true })
  await writeFile(
    join(roots.droidSessionsDir, 'droid-session.jsonl'),
    jsonlBody([
      {
        type: 'system',
        session_id: 'droid-session',
        timestamp: '2026-05-01T10:09:00.000Z',
        model: 'droid-model',
        cwd: '/tmp/droid'
      },
      {
        type: 'message',
        session_id: 'droid-session',
        timestamp: '2026-05-01T10:09:01.000Z',
        role: 'user',
        text: 'Droid title'
      },
      {
        type: 'completion',
        session_id: 'droid-session',
        timestamp: '2026-05-01T10:09:02.000Z',
        usage: { input_tokens: 2, output_tokens: 3 }
      }
    ])
  )

  return { ompSessionFile, primeAgentSessionFile }
}
