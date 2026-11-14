import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import {
  createRestTestRig,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../host/structured-agent-session-registry'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

it('saves a fork under its source name, with no " fork" suffix', async () => {
  const test = forkTestSource(rig)
  test.record.conversationName = 'Annotate capabilities'
  const params = await test.prepare()
  expect(test.copy.mock.calls[0]![0].title).toBe('Annotate capabilities')
  expect(params.adopt?.conversationName).toBe('Annotate capabilities')
})

it('saves a fork of an unnamed chat under the agent default label', async () => {
  const test = forkTestSource(rig)
  test.record.conversationName = undefined
  await test.prepare()
  expect(test.copy.mock.calls[0]![0].title).toBe('Codex Chat')
})
