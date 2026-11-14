import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

const ROOT_ID = '5883db93-32ca-48da-ba29-db952021d273'
const WORKER_ID = 'dc08d047-adfd-4190-a0f4-6c3f7167d394'

describe('Droid mission resume identity', () => {
  let dir: string
  let server: AgentHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-droid-server-'))
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  // Droid writes `callingSessionId` on the first transcript record of sub-sessions only.
  function transcript(id: string, callingSessionId?: string): string {
    const path = join(dir, `${id}.jsonl`)
    const start = { type: 'session_start', id, ...(callingSessionId ? { callingSessionId } : {}) }
    writeFileSync(path, `${JSON.stringify(start)}\n`)
    return path
  }

  function body(sessionId: string, transcriptPath: string, event: string) {
    return buildBody(
      {
        hook_event_name: event,
        session_id: sessionId,
        transcript_path: transcriptPath,
        tool_name: 'Execute',
        prompt: 'run the mission'
      },
      { launchToken: 'droid-token' }
    )
  }

  async function post(sessionId: string, transcriptPath: string, event: string) {
    expect(
      (await postHookEvent(server, body(sessionId, transcriptPath, event), '/hook/droid')).status
    ).toBe(204)
  }

  const resumeId = () => server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id

  it('keeps the orchestrator as the resume target while its workers report', async () => {
    const rootPath = transcript(ROOT_ID)
    const workerPath = transcript(WORKER_ID, ROOT_ID)

    await post(WORKER_ID, workerPath, 'PreToolUse')
    expect(resumeId()).toBeUndefined()

    await post(ROOT_ID, rootPath, 'UserPromptSubmit')
    await post(WORKER_ID, workerPath, 'PreToolUse')
    await post(WORKER_ID, workerPath, 'Stop')
    expect(resumeId()).toBe(ROOT_ID)

    // Dismissing the row keeps only the resume identity; the mission is still running.
    server.dropStatusEntry(PANE)
    await post(WORKER_ID, workerPath, 'PreToolUse')
    expect(resumeId()).toBe(ROOT_ID)
  })
})
