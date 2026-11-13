import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { STRUCTURED_AGENT_SESSION_IDLE_MS as IDLE_MS } from '../../termination/structured-agent-session-idle-sweep'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  readerSaw,
  sweepOnce,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig

beforeEach(async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only which optional methods each double declares; voice is Codex's.
  const claude = {} as StructuredAgentSessionAdapter
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; the host only checks that Codex declares voice.
  const codex = { startVoiceConversation: vi.fn() } as unknown as StructuredAgentSessionAdapter
  rig = await createRestTestRig({
    agents: claudeAndCodexAgents({ claude, codex }),
    idleSweep: { intervalMs: 3_600_000 }
  })
  await foundRestTestChat(rig)
})

afterEach(async () => {
  await rig.dispose()
})

async function putToRest(): Promise<void> {
  rig.clock.now += IDLE_MS + 1
  await sweepOnce(rig.host)
  expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
}

async function readTexts(): Promise<string[]> {
  const reader = collectSubscriber()
  await rig.host.subscribe({ id: `reader-${rig.clock.now}`, sessionId: SESSION, emit: reader.emit })
  return readerSaw(reader.events).texts
}

function liveChildPhase(): string | undefined {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase
}

describe('Voice mode on a Codex chat that idle stop put to rest', () => {
  it('starts its agent once, resumed on the same thread, without sending anything', async () => {
    await putToRest()

    await rig.host.entry.wakeForVoice(SESSION)

    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire.mock.calls[1]?.[0].identity.providerHandle).toMatchObject({
      agent: 'codex',
      nativeId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
    })
    expect(liveChildPhase()).toBe('ready')
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
    expect(await readTexts()).toContain('hello')
  })

  it('starts one agent when two calls wake it at once', async () => {
    await putToRest()

    await Promise.all([rig.host.entry.wakeForVoice(SESSION), rig.host.entry.wakeForVoice(SESSION)])

    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(liveChildPhase()).toBe('ready')
  })

  it('wakes again after the chat goes back to rest', async () => {
    await putToRest()
    await rig.host.entry.wakeForVoice(SESSION)
    await putToRest()

    await rig.host.entry.wakeForVoice(SESSION)

    expect(rig.adapter.acquire).toHaveBeenCalledTimes(3)
    expect(liveChildPhase()).toBe('ready')
    expect(await readTexts()).toContain('hello')
  })
})
