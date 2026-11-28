import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { AGY_HOST_SELECTION } from '../../../antigravity/agy-account-selection'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../construction/test-context/runtime-store-partial-fixture'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'

const WORKSPACE = 'folder:ws'
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const AGY = 'pty-agy'

let folder: string
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(folder, { recursive: true, force: true })
})

function selectHostAccount(accountId: string): void {
  AGY_HOST_SELECTION.note({ selectedAccountId: accountId, accounts: [] })
}

/** One local terminal running agy in conversation `conv`; `events` records stops and relaunches. */
async function runtimeWithAgyTerminal(
  options: { settings?: Partial<GlobalSettings>; connectionId?: string; isWsl?: boolean } = {}
) {
  folder = mkdtempSync(join(tmpdir(), 'orca-agy-switch-'))
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKSPACE]: [
        {
          id: TAB,
          ptyId: AGY,
          worktreeId: WORKSPACE,
          title: 'agy',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: AGY }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`${TAB}:${LEAF}`]: {
        paneKey: `${TAB}:${LEAF}`,
        tabId: TAB,
        worktreeId: WORKSPACE,
        agent: 'antigravity',
        providerSession: { key: 'conversation_id', id: 'conv' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1
      }
    }
  }
  const workspace = storeFolderWorkspace({ id: 'ws', projectGroupId: 'group', folderPath: folder })
  const store = withDurableRuntimeStore(
    partialRuntimeStore({
      getFolderWorkspaces: () => [workspace],
      getFolderWorkspace: () => workspace,
      getWorkspaceSession: () => session,
      ...(options.settings
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads only its own setting.
          { getSettings: () => options.settings as GlobalSettings }
        : {})
    })
  )
  const runtime = new OrcaRuntimeService(store)
  const events: string[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      events.push(`stop ${ptyId}`)
      events.push(`exited ${ptyId}`)
      return true
    },
    getForegroundProcess: async () => 'agy'
  })
  // The relaunch itself is the terminal service's; this records what it was asked to start.
  const relaunch: { createRuntimeOwnedMobileSessionTerminal: CreateTerminal } =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the protected method exists on every runtime; the spy replaces it.
    runtime as unknown as { createRuntimeOwnedMobileSessionTerminal: CreateTerminal }
  vi.spyOn(relaunch, 'createRuntimeOwnedMobileSessionTerminal').mockImplementation(
    async (_worktreeId, _active, _origin, launch) => {
      events.push(`launch ${launch.command}`)
      return { tab: { status: 'ready', ptyId: 'pty-agy-next' } }
    }
  )
  const restarts = vi.spyOn(runtime, 'restartAgentPaneInPlace')
  await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  runtime.registerPty(
    AGY,
    WORKSPACE,
    options.connectionId ?? null,
    { tabId: TAB, leafId: LEAF },
    options.isWsl
  )
  return { runtime, events, restarts }
}

type CreateTerminal = (
  worktreeId: string,
  active: boolean,
  origin: unknown,
  launch: { command: string }
) => Promise<unknown>

/** A queued restart starts within a few microtasks of the reply; none started by then never will. */
async function settled(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

it('restarts agy in place on the new account: stop, wait for exit, relaunch the conversation', async () => {
  const { runtime, events, restarts } = await runtimeWithAgyTerminal({
    settings: { antigravityAccountSwitchRunningSessions: 'restart' }
  })
  selectHostAccount('next')

  const reply = await runtime.onAntigravityAccountSwitched({ from: 'prev', to: 'next' })

  expect(reply).toEqual({ runningSessions: { restarting: 1, notMoved: 0 } })
  await vi.waitFor(() => expect(events).toHaveLength(3))
  expect(events).toEqual([`stop ${AGY}`, `exited ${AGY}`, "launch agy '--conversation' 'conv'"])
  expect(restarts).toHaveBeenCalledTimes(1)
})

it('never restarts under Keep', async () => {
  const { runtime, events, restarts } = await runtimeWithAgyTerminal({
    settings: { antigravityAccountSwitchRunningSessions: 'keep' }
  })
  selectHostAccount('next')

  expect(await runtime.onAntigravityAccountSwitched({ from: 'prev', to: 'next' })).toEqual({})
  await settled()
  expect({ restarts: restarts.mock.calls.length, events }).toEqual({ restarts: 0, events: [] })
})

it('leaves a windowless host’s terminals under Ask until the switching client answers', async () => {
  const { runtime, events, restarts } = await runtimeWithAgyTerminal()
  selectHostAccount('next')

  const reply = await runtime.onAntigravityAccountSwitched({ from: 'prev', to: 'next' })
  await settled()
  expect({ reply, events, restarts: restarts.mock.calls.length }).toEqual({
    reply: { runningSessions: { restarting: 0, notMoved: 1, canRestart: 1 } },
    events: [],
    restarts: 0
  })

  expect(await runtime.answerAntigravityAsk('next')).toEqual({ restarting: 1, notMoved: 0 })
  await vi.waitFor(() => expect(events[0]).toBe(`stop ${AGY}`))
})

it('lets the switching client’s choice override the host’s setting', async () => {
  const { runtime, events, restarts } = await runtimeWithAgyTerminal({
    settings: { antigravityAccountSwitchRunningSessions: 'restart' }
  })
  selectHostAccount('next')

  expect(
    await runtime.onAntigravityAccountSwitched({
      from: 'prev',
      to: 'next',
      runningSessions: 'keep'
    })
  ).toEqual({})
  await settled()
  expect({ restarts: restarts.mock.calls.length, events }).toEqual({ restarts: 0, events: [] })
})

it('hands a CLI switch on a desktop host to its window, which restarts its own terminals', async () => {
  const { runtime, events, restarts } = await runtimeWithAgyTerminal({
    settings: { antigravityAccountSwitchRunningSessions: 'restart' }
  })
  runtime.attachWindow(1)
  const accountSelectedElsewhere = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch calls only this notice.
  runtime.setNotifier({ accountSelectedElsewhere } as never)
  selectHostAccount('next')

  expect(await runtime.onAntigravityAccountSwitched({ from: 'prev', to: 'next' })).toEqual({})
  await settled()
  const restarted = restarts.mock.calls.length
  expect({ calls: accountSelectedElsewhere.mock.calls, events, restarted }).toEqual({
    calls: [
      [
        'antigravity',
        {
          previousAccountId: 'prev',
          accountId: 'next',
          terminals: [{ ptyId: AGY, accountId: 'prev' }],
          accountEmails: {}
        }
      ]
    ],
    events: [],
    restarted: 0
  })
})

it.each([
  ['an SSH terminal', { connectionId: 'ssh-1' }],
  ['a WSL terminal', { isWsl: true }]
])('skips %s, which keeps its own agy login', async (_case, terminal) => {
  const { runtime } = await runtimeWithAgyTerminal(terminal)
  selectHostAccount('next')

  expect(
    await runtime.onAntigravityAccountSwitched({
      from: 'prev',
      to: 'next',
      movesRunningSessions: true
    })
  ).toEqual({})
})

it('lists a kept terminal on the account it runs on, so switching back moves nothing', async () => {
  const { runtime } = await runtimeWithAgyTerminal()
  selectHostAccount('next')
  const listed = await runtime.onAntigravityAccountSwitched({
    from: 'prev',
    to: 'next',
    movesRunningSessions: true
  })
  expect(listed.runningTerminals?.terminals).toEqual([{ ptyId: AGY, accountId: 'prev' }])

  selectHostAccount('third')
  const kept = await runtime.onAntigravityAccountSwitched({
    from: 'next',
    to: 'third',
    movesRunningSessions: true
  })
  expect(kept.runningTerminals?.terminals).toEqual([{ ptyId: AGY, accountId: 'prev' }])

  selectHostAccount('prev')
  expect(
    await runtime.onAntigravityAccountSwitched({
      from: 'third',
      to: 'prev',
      movesRunningSessions: true
    })
  ).toEqual({})
})
