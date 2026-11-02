import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import {
  savedTranscript,
  switchFromKeptTerminal
} from './structured-agent-session-switch-execution.test-fixture'
import { TerminalRevealUnconfirmedError } from '../../session-tabs/terminal-not-placed-error'
import { chatTabId } from '../../agent-session/agent-session-tab-layout'

// A switch's commit point is the chat-tab record: the layout owner first says which tab would
// change, the record commits, and only then does the tab change. Before it nothing changed; after
// it the switch happened, whatever the window's answer.

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

it.each([
  ['the chat’s record cannot be written', 'journal'],
  ['the answer to the change is lost', 'lost'],
  ['the tab changed between the decision and the change', 'refused']
] as const)('records the chat’s tab before the tab changes: %s', async (_name, cut) => {
  await savedTranscript(rig)
  const before = rig.store.getSessionTabId(id)
  const changes: boolean[] = []
  const record = rig.host.setSessionTabVisibility
  const { result, settled, stoppedSource } = await switchFromKeptTerminal({
    afterStop: async (runtime) => {
      vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(
        async (_workspace, _request, decide) => {
          changes.push(decide === true)
          if (decide) {
            return { retargeted: true, tabId: TAB_ID }
          }
          if (cut === 'lost') {
            throw new TerminalRevealUnconfirmedError('renderer_unavailable')
          }
          return { retargeted: false }
        }
      )
      vi.spyOn(rig.host, 'setSessionTabVisibility').mockImplementation(
        async (sessionId, visible, tabId, options) => {
          if (cut === 'journal' && options?.move) {
            throw new Error('fixture journal failure')
          }
          return record(sessionId, visible, tabId, options)
        }
      )
    }
  })
  if (cut === 'journal') {
    // Nothing committed: the tab never changed and the stopped source stays as it was.
    expect(result.status).toBe('refused')
    expect(changes).toEqual([true])
    expect(rig.store.getSessionTabId(id)).toBe(before)
    expect(settled).toHaveBeenCalledExactlyOnceWith(stoppedSource)
    return
  }
  // Committed: the switch happened, whatever the window's answer, and its source was replaced.
  expect(result).toEqual({ status: 'completed', sessionId: id })
  expect(changes).toEqual([true, false])
  if (cut === 'lost') {
    expect(rig.store.getSessionTabId(id)).toBe(TAB_ID)
    expect(settled).toHaveBeenCalledExactlyOnceWith({ ...stoppedSource, replacedBySessionId: id })
  } else {
    // The record follows the chat to the ordinary tab it opened in instead.
    expect(rig.store.getSessionTabId(id)).toBe(chatTabId(id))
  }
})

it.each([
  ['commits', false],
  ['cannot commit', true]
] as const)(
  'takes the chat out of the saved tabs before its tab changes: the record %s',
  async (_name, fails) => {
    const { runtime } = setupMainOwnedWorkspace()
    await rig.store.setSessionTabVisibility(id, false)
    await rig.store.setSessionTabVisibility(id, true, 'source-chat')
    vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: WORKTREE_ID,
      path: rig.root,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const killFenced = vi.fn(async () => ({ outcome: 'ended' as const }))
    runtime.setPtyController({
      spawn: async () => ({
        id: 'switch-pty',
        incarnationId: '55555555-5555-4555-8555-555555555555'
      }),
      killFenced,
      write: () => true,
      kill: () => true,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null
    })
    const steps: string[] = []
    vi.spyOn(runtime, 'setSwitchedTabContent').mockImplementation(async (_ws, _request, decide) => {
      steps.push(decide ? 'decide' : 'change')
      return { retargeted: true, tabId: 'source-chat' }
    })
    const record = rig.host.setSessionTabVisibility
    vi.spyOn(rig.host, 'setSessionTabVisibility').mockImplementation(
      async (sessionId, visible, tabId, options) => {
        if (!visible) {
          steps.push('hide')
          if (fails) {
            throw new Error('fixture journal failure')
          }
        }
        return record(sessionId, visible, tabId, options)
      }
    )
    const result = await executeStructuredSessionSwitch(
      { sessionId: id, execution: { invocationId: 'hide-first', sourceTabId: 'source-chat' } },
      { runtime },
      'terminal'
    )
    if (fails) {
      // The chat's tab never changed, so the chat stays and nothing will show the parked CLI.
      expect(result.status).not.toBe('completed')
      expect(steps).toEqual(['decide', 'hide'])
      expect(rig.store.getSessionTabId(id)).toBe('source-chat')
      expect(killFenced).toHaveBeenCalledOnce()
      return
    }
    // A window that saved the terminal in the chat's tab can never restore beside a record still
    // listing that chat there: the record went first.
    expect(result).toMatchObject({ status: 'completed', sessionId: id })
    expect(steps).toEqual(['decide', 'hide', 'change'])
    expect(rig.store.getSessionTabId(id)).toBeNull()
    expect(killFenced).not.toHaveBeenCalled()
  }
)
