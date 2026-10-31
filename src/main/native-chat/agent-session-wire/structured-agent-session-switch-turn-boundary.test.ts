import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { armSwitchTurnBoundaryWait } from './structured-agent-session-switch-turn-boundary'

const TURN = 'stopped-turn'
/** One Codex rollout event, as the agent appends it. */
type CodexEventPayload = { type: string; turn_id?: string; message?: string }
const row = (payload: CodexEventPayload) => `${JSON.stringify({ type: 'event_msg', payload })}\n`
let root: string
let filePath: string
let controller: AbortController
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-turn-boundary-'))
  filePath = join(root, 'rollout.jsonl')
  controller = new AbortController()
})
afterEach(async () => {
  controller.abort()
  await rm(root, { recursive: true, force: true })
})

async function arm(remainingMs: number) {
  return armSwitchTurnBoundaryWait(
    { agent: 'codex', sessionId: 'thread', filePath },
    { agent: 'codex', sessionId: 'thread', userItemKey: 'user', turnId: TURN, baseline: [] },
    controller.signal,
    () => remainingMs
  )
}

it('reads only what the agent appends, so a long history costs nothing and the wait stays bounded', async () => {
  const history = row({ type: 'agent_message', message: 'x'.repeat(1_000) }).repeat(20_000)
  await writeFile(filePath, `${history}${row({ type: 'task_started', turn_id: TURN })}`)
  const armedAt = performance.now()
  const wait = await arm(1_400)
  // An earlier turn's end in the appended rows is not the stopped turn's.
  await appendFile(filePath, row({ type: 'task_complete', turn_id: 'earlier' }))
  await wait()
  const elapsed = performance.now() - armedAt
  expect(elapsed).toBeGreaterThanOrEqual(350)
  expect(elapsed).toBeLessThan(1_500)
})

it('returns as soon as the stopped turn’s end is recorded', async () => {
  await writeFile(filePath, row({ type: 'task_started', turn_id: TURN }))
  const wait = await arm(60_000)
  const started = performance.now()
  setTimeout(() => void appendFile(filePath, row({ type: 'turn_aborted', turn_id: TURN })), 150)
  await wait()
  expect(performance.now() - started).toBeLessThan(1_500)
})

it('never throws: a vanished transcript or an aborted request returns and the stop goes on', async () => {
  await writeFile(filePath, row({ type: 'task_started', turn_id: TURN }))
  const wait = await arm(60_000)
  await rm(filePath)
  await expect(wait()).resolves.toBeUndefined()
  await writeFile(filePath, '')
  const aborted = await arm(60_000)
  const started = performance.now()
  setTimeout(() => controller.abort(), 100)
  await expect(aborted()).resolves.toBeUndefined()
  expect(performance.now() - started).toBeLessThan(1_500)
  const missing = await armSwitchTurnBoundaryWait(
    { agent: 'codex', sessionId: 'thread', filePath: join(root, 'missing.jsonl') },
    { agent: 'codex', sessionId: 'thread', userItemKey: 'user', turnId: TURN, baseline: [] },
    new AbortController().signal,
    () => 60_000
  )
  await expect(missing()).resolves.toBeUndefined()
})
