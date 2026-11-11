import { afterEach, expect, it, vi } from 'vitest'
import * as historyFiles from '../../../daemon/history/storage/terminal-history-recovery-quarantine'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { getHistorySessionDirName } from '../../../daemon/history/storage/history-paths'
import { readHostTerminalHistory } from './host-terminal-history-read'
import { SessionReadTerminalHistoryParams } from '../../../../shared/rpc-contract/session-terminal-history-params'
import { Terminal } from '@xterm/headless'
import { readSavedTerminalHistory } from '../../../../renderer/src/components/terminal-pane/pty-connection/reattach/retained-terminal-history'
import type { ConnectPanePtySession } from '../../../../renderer/src/components/terminal-pane/pty-connection/connect-pane-pty-session'
import {
  createTestStore,
  seedStore
} from '../../../../renderer/src/store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../../renderer/src/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../../renderer/src/store/repos/repo.test-fixture'

const rendererHistory = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: null as ReturnType<typeof createTestStore> | null
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rendererHistory.rpc }))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => rendererHistory.store!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      rendererHistory.store!.setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      rendererHistory.store!.subscribe(...args)
  }
}))

const request = SessionReadTerminalHistoryParams.parse({
  worktreeId: 'repo::/bare',
  tabId: 'saved-tab',
  leafId: '9300e770-619b-46a9-b648-f31d85641c19'
})
const LEAF = request.leafId
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const historyPath = mkdtempSync(join(tmpdir(), 'sta14647-saved-history-'))
  directories.push(historyPath)
  const sessionDir = join(historyPath, getHistorySessionDirName('saved-shell'))
  mkdirSync(sessionDir)
  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify({
      cwd: '/bare',
      cols: 80,
      rows: 24,
      startedAt: '2026-11-10T01:00:00Z',
      endedAt: '2026-11-10T02:00:00Z',
      exitCode: 0
    })
  )
  writeFileSync(
    join(sessionDir, 'checkpoint.json'),
    JSON.stringify({
      snapshotAnsi: 'SAVED-ENDED-OUTPUT\r\n',
      scrollbackAnsi: '',
      rehydrateSequences: '',
      cwd: '/bare',
      cols: 80,
      rows: 24,
      scrollbackLines: 0,
      checkpointedAt: '2026-11-10T02:00:00Z',
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: false
      }
    })
  )
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      'repo::/bare': [
        {
          id: 'saved-tab',
          ptyId: 'saved-shell',
          worktreeId: 'repo::/bare',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      'saved-tab': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'saved-shell' }
      }
    }
  }
  const store = {
    getWorkspaceSessionHostIds: (): ExecutionHostId[] => ['local'],
    getWorkspaceSession: (_hostId: string) => session
  }
  return { historyPath, sessionDir, session, store }
}

it('reads an ended saved pane without changing its history or association', async () => {
  const { store, historyPath, sessionDir, session } = fixture()
  const before = readdirSync(sessionDir).map((name) => [
    name,
    readFileSync(join(sessionDir, name), 'utf8')
  ])
  const result = await readHostTerminalHistory(store, historyPath, {
    ...request,
    executionHostId: 'local',
    expectedSessionId: 'saved-shell'
  })
  expect(result).toMatchObject({ status: 'restored', cols: 80, rows: 24, partial: false })
  if (result.status === 'restored') {
    expect(result.scrollback).toContain('SAVED-ENDED-OUTPUT')
  }
  expect(session.terminalLayoutsByTabId['saved-tab'].ptyIdsByLeafId?.[LEAF]).toBe('saved-shell')
  expect(
    readdirSync(sessionDir).map((name) => [name, readFileSync(join(sessionDir, name), 'utf8')])
  ).toEqual(before)
})

it.each([
  'fresh tab',
  'new split',
  'new binding',
  'new attempt',
  'closed leaf',
  'new host',
  'disposed',
  'new stream',
  'new tab generation'
] as const)(
  'keeps the original ended image with its current retained destination: %s',
  async (destination) => {
    const { store, historyPath, session } = fixture()
    const siblingLeafId = 'ba9bc9fa-d56d-4a12-ad02-3c2cc3c1e3fb'
    const split = destination === 'new split'
    if (split) {
      session.tabsByWorktree[request.worktreeId][0].ptyId = 'sibling-shell'
      session.terminalLayoutsByTabId[request.tabId] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: siblingLeafId },
          second: { type: 'leaf', leafId: LEAF }
        },
        activeLeafId: siblingLeafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [siblingLeafId]: 'sibling-shell', [LEAF]: 'saved-shell' }
      }
    }
    rendererHistory.rpc.mockReset()
    let afterRead: (() => void) | undefined
    rendererHistory.rpc.mockImplementation(async (_target, _method, params) => {
      const result = await readHostTerminalHistory(
        store,
        historyPath,
        SessionReadTerminalHistoryParams.parse(params)
      )
      afterRead?.()
      return result
    })
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const transport = { getPtyId: () => null }
    const restoredPtyIdByLeafId: Record<string, string> = split
      ? { [siblingLeafId]: 'sibling-shell' }
      : {}
    const fields = {
      pane: { id: 2, leafId: LEAF, terminal },
      transport,
      disposed: false,
      terminalOwnerUnresolved: false,
      transportStreamGeneration: 1,
      tabGeneration: 0,
      runtimeEnvironmentId: null,
      executionHostId: 'local',
      terminalHistoryReadOwner: { environmentId: null, pairingRevision: undefined },
      cacheKey: `${request.tabId}:${LEAF}`,
      tab: {
        ...session.tabsByWorktree[request.worktreeId][0],
        ptyId: split ? 'sibling-shell' : null
      },
      deps: {
        tabId: request.tabId,
        worktreeId: request.worktreeId,
        restoredLeafId: split ? siblingLeafId : undefined,
        restoredPtyIdByLeafId,
        paneTransportsRef: { current: new Map([[2, transport]]) }
      },
      writeReplayData: (data: string) => terminal.write(data)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the addressed history reader's session and image owners.
    const renderer = fields as unknown as ConnectPanePtySession
    rendererHistory.store = createTestStore()
    seedStore(rendererHistory.store, {
      repos: [{ ...TEST_REPO, id: 'repo', path: '/bare', executionHostId: 'local' }],
      worktreesByRepo: {
        repo: [
          makeWorktree({
            id: request.worktreeId,
            repoId: 'repo',
            path: '/bare',
            hostId: 'local'
          })
        ]
      },
      tabsByWorktree: { [request.worktreeId]: [fields.tab] },
      terminalLayoutsByTabId: {
        [request.tabId]: {
          ...session.terminalLayoutsByTabId[request.tabId],
          ptyIdsByLeafId: fields.deps.restoredPtyIdByLeafId
        }
      },
      terminalPaneStartsByPaneKey: {
        [fields.cacheKey]: {
          status: 'failed',
          retainedTerminalStart: {
            ...request,
            runtimeId: 'runtime-local',
            executionHostId: 'local',
            startSequence: 1,
            bindingGeneration: 0,
            status: 'failed',
            reason: 'The shell ended.'
          }
        }
      }
    })
    afterRead = () => {
      const current = rendererHistory.store!
      const state = current.getState()
      if (destination === 'new binding' || destination === 'closed leaf') {
        current.setState({
          terminalLayoutsByTabId: {
            [request.tabId]: {
              ...state.terminalLayoutsByTabId[request.tabId],
              ...(destination === 'new binding'
                ? { ptyIdsByLeafId: { [LEAF]: 'accepted-successor' } }
                : { root: null })
            }
          }
        })
      } else if (destination === 'new attempt') {
        const previous = state.terminalPaneStartsByPaneKey[fields.cacheKey]
        current.setState({
          terminalPaneStartsByPaneKey: {
            [fields.cacheKey]: {
              ...previous,
              retainedTerminalStart: { ...previous.retainedTerminalStart!, startSequence: 2 }
            }
          }
        })
      } else if (destination === 'new host') {
        current.setState({
          repos: [{ ...TEST_REPO, id: 'repo', path: '/bare', executionHostId: 'runtime:other' }],
          worktreesByRepo: {
            repo: [
              makeWorktree({
                id: request.worktreeId,
                repoId: 'repo',
                path: '/bare',
                hostId: 'runtime:other'
              })
            ]
          }
        })
      } else if (destination === 'new tab generation') {
        current.setState({
          tabsByWorktree: {
            [request.worktreeId]: [{ ...fields.tab, generation: 1 }]
          }
        })
      } else if (destination === 'disposed') {
        renderer.disposed = true
      } else if (destination === 'new stream') {
        renderer.transportStreamGeneration += 1
      }
    }
    try {
      await Promise.all([readSavedTerminalHistory(renderer), readSavedTerminalHistory(renderer)])
      await new Promise<void>((done) => terminal.write('', done))
      const buffer = terminal.buffer.active
      const displayed = Array.from(
        { length: buffer.length },
        (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
      ).join('\n')
      if (destination === 'fresh tab' || destination === 'new split') {
        expect(displayed).toContain('SAVED-ENDED-OUTPUT')
      } else {
        expect(displayed).not.toContain('SAVED-ENDED-OUTPUT')
      }
      expect(terminal.options.disableStdin).toBe(true)
      expect(rendererHistory.rpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'local' },
        'session.readTerminalHistory',
        { ...request, executionHostId: 'local' },
        expect.any(Object)
      )
      if (destination === 'new attempt') {
        afterRead = undefined
        await readSavedTerminalHistory(renderer)
        await new Promise<void>((done) => terminal.write('', done))
        expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain(
          'SAVED-ENDED-OUTPUT'
        )
        expect(rendererHistory.rpc).toHaveBeenCalledTimes(2)
      }
    } finally {
      terminal.dispose()
    }
  }
)

it('never reads another workspace, leaf, saved key, or execution owner', async () => {
  const { store, historyPath } = fixture()
  for (const address of [
    { ...request, worktreeId: 'repo::/other' },
    SessionReadTerminalHistoryParams.parse({
      ...request,
      leafId: 'ba9bc9fa-d56d-4a12-ad02-3c2cc3c1e3fb'
    }),
    { ...request, expectedSessionId: 'someone-elses-shell' },
    { ...request, executionHostId: 'ssh:missing' }
  ]) {
    expect(await readHostTerminalHistory(store, historyPath, address)).toEqual({ status: 'absent' })
  }
  store.getWorkspaceSessionHostIds = () => ['local', 'ssh:other']
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({
    status: 'ambiguous'
  })
  expect(
    await readHostTerminalHistory(store, historyPath, { ...request, executionHostId: 'ssh:other' })
  ).toEqual({ status: 'unsupported' })
})

it('discards a read whose saved owner changed while the history was loading', async () => {
  const { store, historyPath, session } = fixture()
  let reads = 0
  store.getWorkspaceSession = () => {
    if (++reads > 1) {
      session.terminalLayoutsByTabId['saved-tab'].ptyIdsByLeafId = { [LEAF]: 'replacement-shell' }
    }
    return session
  }
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({ status: 'changed' })
})

it('discards changing history and respects explicit removal protection', async () => {
  const { store, historyPath, sessionDir, session } = fixture()
  const fingerprint = historyFiles.fingerprintTerminalHistorySessionAsync
  let reads = 0
  vi.spyOn(historyFiles, 'fingerprintTerminalHistorySessionAsync').mockImplementation(
    async (...args) => {
      if (++reads === 2) {
        writeFileSync(join(sessionDir, 'new-output'), 'LATER-OUTPUT')
      }
      return fingerprint(...args)
    }
  )
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({ status: 'changed' })
  writeFileSync(join(sessionDir, '.unreadable-recovery'), 'protected')
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({
    status: 'unreadable'
  })
  session.closedTerminalTabTombstonesByTabId = {
    'saved-tab': { worktreeId: 'repo::/bare', closedAt: Date.now(), reason: 'user' }
  }
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({ status: 'absent' })
})

it('discards a saved owner changed during the final asynchronous fingerprint', async () => {
  const { store, historyPath, session } = fixture()
  const fingerprint = historyFiles.fingerprintTerminalHistorySessionAsync
  let reads = 0
  vi.spyOn(historyFiles, 'fingerprintTerminalHistorySessionAsync').mockImplementation(
    async (...args) => {
      const value = await fingerprint(...args)
      if (++reads === 2) {
        session.terminalPtyIncarnationsByPaneKey = {
          [`saved-tab:${LEAF}`]: 'successor-incarnation'
        }
      }
      return value
    }
  )
  expect(await readHostTerminalHistory(store, historyPath, request)).toEqual({ status: 'changed' })
})

it('lets a retired requester cancel instead of presenting cancellation as unreadable history', async () => {
  const { store, historyPath } = fixture()
  const fingerprint = historyFiles.fingerprintTerminalHistorySessionAsync
  const controller = new AbortController()
  const retired = new Error('requesting document retired')
  vi.spyOn(historyFiles, 'fingerprintTerminalHistorySessionAsync').mockImplementation(
    async (...args) => {
      const value = await fingerprint(...args)
      controller.abort(retired)
      return value
    }
  )
  await expect(
    readHostTerminalHistory(store, historyPath, request, controller.signal)
  ).rejects.toBe(retired)
})
