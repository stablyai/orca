import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internals } from '../../../agent-hooks/server/agent-hook-server'
import { closeProviderTimelineRigs } from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { PROVIDER_SESSION } from '../testing/acp-structured-adapter.test-support'
import {
  openHostRig,
  attachParams,
  promptIdOf,
  send
} from '../testing/acp-structured-host.test-support'
import { acpChildWorkStatusSink } from '../testing/acp-structured-child-work.test-support'
import type { FakeFrame } from '../../process/testing/acp-scripted-agent.test-support'

beforeEach(() => _internals.resetCachesForTests())
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

function cleanupScriptedHost(hosted: Awaited<ReturnType<typeof openHostRig>>) {
  let prompt: FakeFrame | undefined
  cleanup.push(async () => {
    const scriptedPrompt = prompt
    if (scriptedPrompt) {
      const { agent } = hosted.rig.child()
      agent.on('session/cancel', () => agent.reply(scriptedPrompt, { stopReason: 'cancelled' }))
    }
    await hosted.host.close(SESSION, 'user-close')
  })
  return (frame: FakeFrame) => {
    prompt = frame
  }
}

describe('Grok roster evidence through the existing host child store', () => {
  it('keeps the agent strip but hides Stop when the installed peer lacks the targeted route', async () => {
    const childWork = acpChildWorkStatusSink()
    const hosted = await openHostRig({
      statusSink: childWork.sink,
      script: (agent) => {
        agent.on('_x.ai/subagent/cancel', (frame) => agent.fail(frame, -32601, 'Method not found'))
        agent.on('_x.ai/task/kill', (frame) => agent.fail(frame, -32601, 'Method not found'))
      }
    })
    const cancelOnCleanup = cleanupScriptedHost(hosted)
    expect(await hosted.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await send(hosted.host, 'Delegate on older peer')
    const prompt = await hosted.rig.frame('session/prompt')
    cancelOnCleanup(prompt)
    hosted.rig.child().agent.notify('_x.ai/session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child',
        parent_prompt_id: promptIdOf(prompt),
        description: 'Exact label'
      }
    })
    await hosted.host.flushStreamedEvents(SESSION)
    const strip = (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page
      .backgroundTasks
    expect(strip?.tasks).toMatchObject([
      { id: 'child', kind: 'agent', description: 'Exact label', stoppable: false }
    ])
    expect(strip?.supportsTaskStop).not.toBe(true)
  })
})
