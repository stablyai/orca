import { expect, vi } from 'vitest'
import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'

export type Rig = ReturnType<typeof codexInputFinalizationFixture>
export const CALLER = { callerKey: 'client-1' }
export const FAILURE = 'stream disconnected before completion'
export const journalOf = (rig: Rig) =>
  rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
export const hidden = (rig: Rig) =>
  rig.starts().filter((call) => Array.isArray(call.params?.input) && call.params.input.length === 0)
export function clock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}
export async function flush(rig: Rig) {
  await rig.host.flushStreamedEvents(SESSION)
}
export async function fail(rig: Rig, info = 'other') {
  rig.notify('error', {
    threadId: THREAD,
    turnId: rig.turns.turnId,
    willRetry: true,
    error: { message: FAILURE, codexErrorInfo: 'responseStreamDisconnected' }
  })
  rig.turns.end('failed', FAILURE, info)
  await flush(rig)
}
export async function root(rig: Rig) {
  const id = await rig.permissionSend('finish this request', {
    model: 'gpt-live',
    effort: 'medium',
    serviceTier: 'default'
  })
  await rig.began(id)
  return id
}
export async function startHidden(rig: Rig, delay: number, count: number) {
  await vi.advanceTimersByTimeAsync(delay)
  await vi.waitFor(() => expect(hidden(rig)).toHaveLength(count))
  rig.turns.start()
  await flush(rig)
  await vi.advanceTimersByTimeAsync(0)
}
