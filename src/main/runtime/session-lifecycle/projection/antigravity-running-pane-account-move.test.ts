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
import { noteAgyTerminalAuthority } from '../../../antigravity/agy-terminal-authority'

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

/** One local terminal running agy in conversation `conv` (or one Orca doesn't know, with null);
 *  `events` records stops and relaunches. */
async function runtimeWithAgyTerminal(
  options: {
    settings?: Partial<GlobalSettings>
    connectionId?: string
    isWsl?: boolean
    conversation?: string | null
  } = {}
) {
  const conversation = options.conversation === undefined ? 'conv' : options.conversation
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
    sleepingAgentSessionsByPaneKey: conversation
      ? {
          [`${TAB}:${LEAF}`]: {
            paneKey: `${TAB}:${LEAF}`,
            tabId: TAB,
            worktreeId: WORKSPACE,
            agent: 'antigravity',
            providerSession: { key: 'conversation_id', id: conversation },
            prompt: '',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      : {}
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
  if (!conversation) {
    // An agy Orca launched, before any hook named its conversation.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the PTY record map is the runtime's own; only its launch agent is set.
    const records = runtime as unknown as { ptysById: Map<string, { launchAgent: string }> }
    records.ptysById.get(AGY)!.launchAgent = 'antigravity'
  }
  const sleeping = session.sleepingAgentSessionsByPaneKey!
  return { runtime, events, restarts, sleeping }
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

/** What a switch made in the window lists for it: the host's agy terminals off the new account. */
async function listedForWindow(
  runtime: OrcaRuntimeService,
  from: string,
  to: string
): Promise<unknown> {
  selectHostAccount(to)
  const reply = await runtime.onAntigravityAccountSwitched({ from, to, movesRunningSessions: true })
  return reply.runningTerminals?.terminals
}

it.each([
  ['an SSH terminal', { connectionId: 'ssh-1' }],
  ['a WSL terminal', { isWsl: true }]
])('skips %s, which keeps its own agy login', async (_case, terminal) => {
  const { runtime } = await runtimeWithAgyTerminal(terminal)
  expect(await listedForWindow(runtime, 'prev', 'next')).toEqual([])
})

it('lists a kept terminal on the account it runs on, so switching back moves nothing', async () => {
  const { runtime } = await runtimeWithAgyTerminal()
  expect(await listedForWindow(runtime, 'prev', 'next')).toEqual([
    { ptyId: AGY, accountId: 'prev' }
  ])
  expect(await listedForWindow(runtime, 'next', 'third')).toEqual([
    { ptyId: AGY, accountId: 'prev' }
  ])
  expect(await listedForWindow(runtime, 'third', 'prev')).toEqual([])
})

it('lists agy started again in a kept terminal on the account selected as it started', async () => {
  const { runtime, sleeping } = await runtimeWithAgyTerminal()
  expect(await listedForWindow(runtime, 'prev', 'next')).toEqual([
    { ptyId: AGY, accountId: 'prev' }
  ])

  // The user quit agy and ran it again: its hooks name a new conversation.
  sleeping[`${TAB}:${LEAF}`]!.providerSession = { key: 'conversation_id', id: 'conv-2' }

  expect(await listedForWindow(runtime, 'next', 'third')).toEqual([
    { ptyId: AGY, accountId: 'next' }
  ])
})

it('restarts agy with no known conversation by starting a new one, and says so', async () => {
  const { runtime, events } = await runtimeWithAgyTerminal({
    conversation: null,
    settings: { antigravityAccountSwitchRunningSessions: 'restart' }
  })
  selectHostAccount('next')

  expect(await runtime.onAntigravityAccountSwitched({ from: 'prev', to: 'next' })).toEqual({
    runningSessions: { restarting: 1, notMoved: 0, fresh: 1 }
  })
  await vi.waitFor(() => expect(events).toHaveLength(3))
  // A new agy, launched as Orca launches one by default.
  expect(events).toEqual([
    `stop ${AGY}`,
    `exited ${AGY}`,
    "launch agy '--dangerously-skip-permissions'"
  ])
})

it('moves, by the window’s rule, the terminals its window shows no pane for', async () => {
  const { runtime, events } = await runtimeWithAgyTerminal()
  runtime.attachWindow(1)
  expect(await listedForWindow(runtime, 'prev', 'next')).toEqual([
    { ptyId: AGY, accountId: 'prev' }
  ])

  expect(
    await runtime.moveUnheldAntigravityTerminals({
      previousAccountId: 'prev',
      accountId: 'next',
      ptyIds: [AGY],
      runningSessions: 'restart'
    })
  ).toEqual({ restarting: 1, notMoved: 0 })
  await vi.waitFor(() => expect(events[0]).toBe(`stop ${AGY}`))
})

it('never lists a terminal whose agy reads another credential authority’s login', async () => {
  const { runtime } = await runtimeWithAgyTerminal()
  // Spawned without the host's HOME: agy there reads a login no saved account names.
  noteAgyTerminalAuthority(`${TAB}:${LEAF}`, {}, ['HOME'])
  try {
    expect(await listedForWindow(runtime, 'prev', 'next')).toEqual([])
  } finally {
    noteAgyTerminalAuthority(`${TAB}:${LEAF}`, process.env)
  }
})
