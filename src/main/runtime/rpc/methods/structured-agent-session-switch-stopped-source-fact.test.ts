import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { WORKTREE_ID, TAB_ID, PTY_A } from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import {
  keptSourceTerminal,
  savedTranscript
} from './structured-agent-session-switch-execution.test-fixture'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, { location: { ...params.location, workspaceId: WORKTREE_ID } })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

type Kept = ReturnType<typeof keptSourceTerminal>

function switchFrom(kept: Kept, invocationId: string) {
  return executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId,
        source: {
          terminal: kept.source.handle,
          expectedIncarnationId: kept.incarnationId,
          originalPresentation: kept.source.presentation
        }
      }
    },
    { runtime: kept.runtime },
    'chat'
  )
}

async function sourceRow(kept: Kept) {
  const frame = await kept.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return frame.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === TAB_ID)
}

/** The transcript reads before the stop, then is gone: the switch fails after a proven stop. */
async function failingAfterStop() {
  const readable = await savedTranscript(rig)
  const prepare = vi.mocked(cliTranscript.prepareStructuredChatCliTranscript)
  prepare.mockReset()
  prepare.mockResolvedValueOnce(readable).mockResolvedValue({ useRealCodexHome: false })
  return readable
}

it('publishes the stopped source to every viewer when a switch fails after its proven stop', async () => {
  const readable = await failingAfterStop()
  const kept = keptSourceTerminal()
  expect(await switchFrom(kept, 'from-b')).toMatchObject({ status: 'refused' })
  // Any viewer (the client that asked, another one, a reconnect) reads it from the frame.
  const row = await sourceRow(kept)
  expect(row).toMatchObject({
    status: 'ready',
    stoppedSwitchSource: {
      ptyId: PTY_A,
      incarnationId: kept.incarnationId,
      agent: 'codex',
      providerSessionId: readable.cliForkSource!.sessionId
    }
  })
  // An older client reattaching to that exact process is answered exited, not left waiting.
  expect(
    row?.type === 'terminal' &&
      row.status === 'ready' &&
      kept.runtime.isStoppedSwitchSourceHandle(row.terminal)
  ).toBe(true)
  // The retry from the stopped pane replaces it in place; the fact dies with the row.
  vi.mocked(cliTranscript.prepareStructuredChatCliTranscript).mockResolvedValue(readable)
  const retry = kept.runtime.resolveTerminalPane(
    `${TAB_ID}:${kept.stoppedSource.leafId}`,
    WORKTREE_ID
  )
  expect(retry.incarnationId).toBe(kept.incarnationId)
  expect(
    await switchFrom({ ...kept, source: { ...retry, presentation: retry.presentation! } }, 'retry')
  ).toEqual({ status: 'completed', sessionId: id })
  expect(await sourceRow(kept)).toBeUndefined()
  expect(kept.runtime.isStoppedSwitchSourceHandle(kept.source.handle)).toBe(false)
})

it('publishes nothing for a stop it could not prove', async () => {
  await failingAfterStop()
  const kept = keptSourceTerminal({ unproven: true })
  expect(await switchFrom(kept, 'host-lost')).toMatchObject({
    refusal: { details: { reason: 'ownerUnproven' } }
  })
  expect(await sourceRow(kept)).not.toHaveProperty('stoppedSwitchSource')
})

it('publishes nothing when the switch replaced the stopped pane', async () => {
  await savedTranscript(rig)
  const kept = keptSourceTerminal()
  expect(await switchFrom(kept, 'replaced')).toEqual({ status: 'completed', sessionId: id })
  expect(await sourceRow(kept)).toBeUndefined()
})
