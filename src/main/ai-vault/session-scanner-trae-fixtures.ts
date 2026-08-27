import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

export const TRAE_FIXTURE_SESSION_ID = '019fe968-ff04-7e43-8316-983ae577b782'

export function traeFixture(): IncrementalAgentFixture {
  return {
    agent: 'trae',
    fileName: `rollout-2026-08-10T10-03-20-${TRAE_FIXTURE_SESSION_ID}.jsonl`,
    seedLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/trae', model: 'trae-model' }
      }),
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.500Z',
        type: 'turn_context',
        payload: { cwd: '/repo/trae', model: 'trae-model' }
      }),
      JSON.stringify({
        timestamp: '2026-08-10T10:03:21.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Trae seed question' }
      })
    ],
    appendLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:04:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Trae incremental answer' }
      })
    ],
    truncatedLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/trae' }
      })
    ]
  }
}

export async function writeTraeScannerFixtures(sessionsDir: string): Promise<string> {
  const fixture = traeFixture()
  const dateDir = join(sessionsDir, '2026', '08', '10')
  const sessionPath = join(dateDir, fixture.fileName)
  await mkdir(dirname(sessionPath), { recursive: true })
  await writeFile(sessionPath, `${fixture.seedLines.join('\n')}\n`)
  await writeFile(join(dateDir, 'notes.jsonl'), `${fixture.seedLines.join('\n')}\n`)
  const artifactDir = join(dateDir, `${fixture.fileName}.artifacts`)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(join(artifactDir, 'rollout-artifact.jsonl'), `${fixture.seedLines.join('\n')}\n`)
  return sessionPath
}
