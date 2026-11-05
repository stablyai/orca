import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

let server: AgentHookServer | undefined
let directory: string | undefined

afterEach(() => {
  server?.stop()
  server = undefined
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
    directory = undefined
  }
  vi.restoreAllMocks()
})

it('refines a quota transcript flushed after StopFailure without changing its turn end', async () => {
  _internals.resetCachesForTests()
  directory = mkdtempSync(join(tmpdir(), 'orca-terminal-quota-server-'))
  const transcriptPath = join(directory, 'transcript.jsonl')
  writeFileSync(transcriptPath, '')
  const running = new AgentHookServer()
  server = running
  await running.start({ env: 'production', userDataPath: directory })
  const sessionId = '44444444-4444-4444-8444-444444444444'
  const promptId = '22222222-2222-4222-8222-222222222222'
  const post = async (payload: Record<string, unknown>) => {
    const response = await postHookEvent(
      running,
      buildBody({
        session_id: sessionId,
        prompt_id: promptId,
        transcript_path: transcriptPath,
        ...payload
      })
    )
    expect(response.status).toBe(204)
  }
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Finish the task' })
  await post({ hook_event_name: 'StopFailure', error: 'rate_limit' })
  const failed = running.getStatusSnapshotForPane(PANE)[0]
  expect(failed.mainAgent?.usageLimit).toBeUndefined()
  // Positive source-shaped branch; generic provider429 alone is not this typed fact.
  writeFileSync(
    transcriptPath,
    `${[
      {
        type: 'user',
        sessionId,
        promptId,
        isSidechain: false,
        uuid: 'user',
        parentUuid: null,
        message: { content: 'Finish the task' }
      },
      {
        type: 'assistant',
        sessionId,
        isSidechain: false,
        uuid: 'quota',
        parentUuid: 'user',
        apiError: 'usage_limit_reached',
        error: 'rate_limit'
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  await expect
    .poll(() => running.getStatusSnapshotForPane(PANE)[0].mainAgent?.usageLimit)
    .toEqual({})
  const refined = running.getStatusSnapshotForPane(PANE)[0]
  expect(refined.turnEndedAt).toBe(failed.turnEndedAt)
  expect(refined.mainAgent?.stateStartedAt).toBe(failed.mainAgent?.stateStartedAt)
  const guard = running.prepareTerminalUsageLimitContinuation(PANE, {
    sessionId,
    turnEndedAt: refined.turnEndedAt!
  })
  expect(guard?.()).toBe(true)
  // A native continuation may reach the transcript before its hook arrives.
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      sessionId,
      isSidechain: false,
      isMeta: true,
      uuid: 'native-continuation',
      parentUuid: 'quota',
      message: { content: 'Continue' }
    })}\n`
  )
  expect(guard?.()).toBe(false)
  await post({
    hook_event_name: 'UserPromptSubmit',
    prompt_id: '33333333-3333-4333-8333-333333333333',
    prompt: 'Another task'
  })
  expect(running.getStatusSnapshotForPane(PANE)[0].mainAgent?.usageLimit).toBeUndefined()
})
