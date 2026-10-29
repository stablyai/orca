import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mulberry32 } from '../../../shared/agent-tui-ansi-fuzz-stream'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from '../../runtime/mobile-session-terminal-persistence-retirement'
import type { Store } from '../loading-store/store'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { TerminalSurfaceCloseOptions } from '../../runtime/terminal-surface-close'
import { leafIds, WindowSession, withoutLeaf } from './terminal-topology-window-session-fixture'
import {
  checkWorkspaceLayoutRules,
  type WorkspaceLayoutPartition,
  type WorkspaceLayoutRule,
  type WorkspaceLayoutViolation
} from '../../../shared/workspace-layout/workspace-layout-rules'
import { closeLeafOrTab } from './terminal-topology-commit'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// Compare seeded gestures on real persistence with an independent model; replay with FUZZ_SEED and FUZZ_ITERATIONS=1.

const WORKTREES = [
  FIXTURE_GIT_WORKTREE_ID,
  FIXTURE_FOLDER_WORKTREE_ID,
  FLOATING_TERMINAL_WORKTREE_ID
]
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 0x9417)
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 6)
const OPS_PER_SEED = 40

type ModelPane = { ptyId: string | undefined; sleeping: boolean }
type Model = Map<string, { worktreeId: string; leaves: Map<string, ModelPane> }>

const directories: string[] = []

function makeIds(random: () => number) {
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('')
  return {
    leaf: () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`,
    tab: () => `tab-${hex(8)}`,
    pty: (worktreeId: string) => `${worktreeId}@@${hex(8)}`
  }
}

function sleepingRecord(
  worktreeId: string,
  tabId: string,
  leafId: string
): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:${leafId}`,
    tabId,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${leafId}` },
    prompt: 'model',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit'
  }
}

function layoutViolations(
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState | null
): WorkspaceLayoutViolation[] {
  const partition = (state: WorkspaceSessionState): WorkspaceLayoutPartition[] => [
    { hostId: LOCAL_EXECUTION_HOST_ID, session: state }
  ]
  return checkWorkspaceLayoutRules(partition(session), previous ? partition(previous) : undefined)
}

function expectLayoutRules(
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState | null,
  context: string
): void {
  expect(layoutViolations(session, previous), context).toEqual([])
}

function projectedTopology(session: WorkspaceSessionState) {
  return Object.fromEntries(
    WORKTREES.map((worktreeId) => {
      const tabs = (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => {
        const layout = session.terminalLayoutsByTabId?.[tab.id]
        return {
          tabId: tab.id,
          leaves: Object.fromEntries(
            leafIds(layout?.root).map((leafId) => [leafId, layout?.ptyIdsByLeafId?.[leafId]])
          )
        }
      })
      const sleeping = Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})
        .filter(([, record]) => record.worktreeId === worktreeId)
        .map(([paneKey]) => paneKey)
        .sort()
      return [worktreeId, { tabs, sleeping }]
    })
  )
}

function expectedTopology(model: Model) {
  return Object.fromEntries(
    WORKTREES.map((worktreeId) => {
      const entries = [...model.entries()].filter(([, tab]) => tab.worktreeId === worktreeId)
      const tabs = entries.map(([tabId, tab]) => ({
        tabId,
        leaves: Object.fromEntries([...tab.leaves].map(([leafId, pane]) => [leafId, pane.ptyId]))
      }))
      const sleeping = entries
        .flatMap(([tabId, tab]) =>
          [...tab.leaves]
            .filter(([, pane]) => pane.sleeping)
            .map(([leafId]) => `${tabId}:${leafId}`)
        )
        .sort()
      return [worktreeId, { tabs, sleeping }]
    })
  )
}

type Op =
  | 'new_tab'
  | 'split'
  | 'close_pane'
  | 'close_tab'
  | 'move_pane'
  | 'pty_exit'
  | 'respawn'
  | 'sleep'
  | 'wake'
  | 'restart'
  | 'quit_restart'
  | 'client_close_tab'
  | 'client_split'
  | 'exit_retire'

const OPS: readonly Op[] = [
  'new_tab',
  'new_tab',
  'split',
  'split',
  'close_pane',
  'close_tab',
  'move_pane',
  'pty_exit',
  'respawn',
  'sleep',
  'wake',
  'restart',
  'quit_restart',
  'client_close_tab',
  'client_split',
  'exit_retire'
]

type Writer =
  | 'load'
  | 'window save'
  | 'stale window save'
  | 'quit stage'
  | 'spawn bind'
  | 'close commit'
  | 'leaf move'
  | 'client close'
  | 'host split'
  | 'exit retire'

/** Two-writer intermediate tab rows may lack bar entries; all exemptions must heal by step end. */
const TWO_WRITER_TRANSIENTS: readonly { rule: WorkspaceLayoutRule; op: Op; writer: Writer }[] = [
  { rule: 'tab_bar_missing', op: 'new_tab', writer: 'spawn bind' },
  { rule: 'tab_lists_disagree', op: 'new_tab', writer: 'spawn bind' },
  { rule: 'tab_lists_disagree', op: 'move_pane', writer: 'leaf move' }
]

function isTwoWriterTransient(violation: WorkspaceLayoutViolation, op: Op, writer: Writer) {
  return TWO_WRITER_TRANSIENTS.some(
    (allowed) => allowed.rule === violation.rule && allowed.op === op && allowed.writer === writer
  )
}

/** Exit retirement updates memory before durability. */
async function retireExitedPane(
  store: Store,
  surface: { worktreeId: string; parentTabId: string; leafId: string; ptyId: string }
): Promise<void> {
  const current = store.getWorkspaceSession()
  const next = retireTerminalSurfaceFromPersistence(current, surface)
  expect(next).not.toBe(current)
  store.setWorkspaceSession(next)
  await store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
}

async function runSeed(seed: number): Promise<string[]> {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(random() * items.length)]
  const ids = makeIds(random)
  const directory = mkdtempSync(join(tmpdir(), 'orca-topology-model-'))
  directories.push(directory)
  let store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(structuredClone(store.getWorkspaceSession()))
  const model: Model = new Map()
  const log: string[] = []
  let previous: WorkspaceSessionState | null = null
  let op: Op = OPS[0]!
  let writer: Writer = 'load'
  // Observe every write so transient breaches cannot hide between gesture boundaries.
  const writeBreaches: string[] = []
  let lastWritten = structuredClone(store.getWorkspaceSession())
  const watchWrites = (): (() => void) =>
    store.onWorkspaceSessionWritten(() => {
      // Observer exceptions would break persistence rather than fail the seed.
      try {
        const session = store.getWorkspaceSession()
        for (const violation of layoutViolations(session, lastWritten)) {
          if (!isTwoWriterTransient(violation, op, writer)) {
            writeBreaches.push(`${writer}: ${violation.rule}: ${violation.detail}`)
          }
        }
        lastWritten = structuredClone(session)
      } catch (error) {
        writeBreaches.push(`write check threw: ${String(error)}`)
      }
    })
  let unwatchWrites = watchWrites()
  const save = (): void => {
    writer = 'window save'
    store.setWorkspaceSession(window.snapshot())
  }
  /** Deliver a pre-change snapshot after ticks event-loop turns. */
  const staleSave = async (stale: WorkspaceSessionState, ticks: number): Promise<void> => {
    for (let tick = 0; tick < ticks; tick++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    writer = 'stale window save'
    store.setWorkspaceSession(stale)
  }
  const labeled =
    <T>(label: Writer, mutate: () => DurableProfileStateMutation<T>) =>
    (): DurableProfileStateMutation<T> => {
      writer = label
      return mutate()
    }
  const panes = () =>
    [...model].flatMap(([tabId, tab]) =>
      [...tab.leaves].map(([leafId, pane]) => ({ tabId, leafId, tab, pane }))
    )
  const splitTabs = () => [...model].filter(([, tab]) => tab.leaves.size > 1)

  const bind = async (worktreeId: string, tabId: string, leafId: string, ptyId: string) => {
    const args = { worktreeId, tabId, leafId, ptyId }
    await expect(
      store.persistPtyBinding(() => {
        writer = 'spawn bind'
        return args
      })
    ).resolves.toBe(true)
    window.bind(tabId, leafId, ptyId)
    model.get(tabId)!.leaves.set(leafId, { ptyId, sleeping: false })
  }

  const closeMutation = (
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions
  ) =>
    closeLeafOrTab({
      worktreeId,
      target,
      options,
      requestedSession: store.getWorkspaceSession(),
      ownerMatches: () => true,
      hostIds: () => [LOCAL_EXECUTION_HOST_ID],
      getSession: (hostId) => store.getWorkspaceSession(hostId),
      setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
      onClosed: () => {}
    })

  const commitClose = async (worktreeId: string, target: TerminalSurfaceCloseTarget) => {
    const refusal = await store.runDurableMutation(
      labeled(
        'close commit',
        closeMutation(worktreeId, target, {
          allowMissing: true,
          force: true,
          closedByLayoutOwner: true,
          reason: 'user'
        })
      )
    )
    expect(refusal).toBeUndefined()
  }

  const windowDropsPane = (tabId: string, leafId: string): void => {
    const layout = window.session.terminalLayoutsByTabId[tabId]!
    const { [leafId]: _closed, ...bindings } = layout.ptyIdsByLeafId ?? {}
    void _closed
    window.setLayout(tabId, withoutLeaf(layout.root!, leafId)!, bindings)
    const { [`${tabId}:${leafId}`]: _record, ...sleeping } =
      window.session.sleepingAgentSessionsByPaneKey ?? {}
    void _record
    window.setSleeping(sleeping)
  }

  const reopen = async (stageQuit: boolean): Promise<void> => {
    if (stageQuit) {
      writer = 'quit stage'
      store.stageWorkspaceSessionBeforeUnload(window.snapshot())
    }
    writer = 'load'
    unwatchWrites()
    store = await reopenTopologyStore(store, directory)
    lastWritten = structuredClone(store.getWorkspaceSession())
    unwatchWrites = watchWrites()
    window.session = structuredClone(store.getWorkspaceSession())
  }

  for (let step = 0; step < OPS_PER_SEED; step++) {
    op = pick(OPS)!
    switch (op) {
      case 'new_tab': {
        const worktreeId = pick(WORKTREES)!
        const tabId = ids.tab()
        const leafId = ids.leaf()
        const ptyId = ids.pty(worktreeId)
        // pty:spawn can beat the window's debounced layout save.
        const spawnFirst = random() < 0.5
        log.push(
          `${op} ${worktreeId} ${tabId}:${leafId} ${ptyId}${spawnFirst ? ' spawn-first' : ''}`
        )
        model.set(tabId, { worktreeId, leaves: new Map() })
        window.addTab(worktreeId, tabId, leafId)
        if (!spawnFirst) {
          save()
        }
        await bind(worktreeId, tabId, leafId, ptyId)
        save()
        break
      }
      case 'split': {
        const target = pick(panes())
        if (!target) {
          continue
        }
        const leafId = ids.leaf()
        const ptyId = ids.pty(target.tab.worktreeId)
        const spawnFirst = random() < 0.5
        const direction = random() < 0.5 ? 'vertical' : 'horizontal'
        log.push(
          `${op} ${target.tabId}:${target.leafId} → ${leafId} ${ptyId}${spawnFirst ? ' spawn-first' : ''}`
        )
        const layout = window.session.terminalLayoutsByTabId[target.tabId]!
        window.setLayout(
          target.tabId,
          {
            type: 'split',
            direction,
            first: layout.root!,
            second: { type: 'leaf', leafId }
          },
          layout.ptyIdsByLeafId ?? {}
        )
        if (!spawnFirst) {
          save()
        }
        await bind(target.tab.worktreeId, target.tabId, leafId, ptyId)
        save()
        break
      }
      case 'close_pane': {
        const [tabId, tab] = pick(splitTabs()) ?? []
        const leafId = tab && pick([...tab.leaves.keys()])
        if (!tabId || !tab || !leafId) {
          continue
        }
        log.push(`${op} ${tabId}:${leafId}`)
        windowDropsPane(tabId, leafId)
        tab.leaves.delete(leafId)
        await commitClose(tab.worktreeId, { kind: 'pane', tabId, leafId })
        save()
        break
      }
      case 'close_tab': {
        const tabId = pick([...model.keys()])
        if (!tabId) {
          continue
        }
        log.push(`${op} ${tabId}`)
        const { worktreeId } = model.get(tabId)!
        window.removeTab(tabId)
        model.delete(tabId)
        await commitClose(worktreeId, { kind: 'tab', tabId })
        save()
        break
      }
      case 'move_pane': {
        const [sourceTabId, source] = pick(splitTabs()) ?? []
        const leafId = source && pick([...source.leaves.keys()])
        if (!sourceTabId || !source || !leafId) {
          continue
        }
        const targetTabId = ids.tab()
        const pane = source.leaves.get(leafId)!
        log.push(`${op} ${sourceTabId}:${leafId} → ${targetTabId}`)
        writer = 'leaf move'
        await expect(
          store.moveTerminalLeafToNewTab({
            worktreeId: source.worktreeId,
            sourceTabId,
            targetTabId,
            leafId,
            ptyId: pane.ptyId ?? null
          })
        ).resolves.toEqual({ status: 'moved', ptyId: pane.ptyId ?? null })
        const layout = window.session.terminalLayoutsByTabId[sourceTabId]!
        const { [leafId]: movedPty, ...bindings } = layout.ptyIdsByLeafId ?? {}
        window.setLayout(sourceTabId, withoutLeaf(layout.root!, leafId)!, bindings)
        window.addTab(source.worktreeId, targetTabId, leafId)
        if (movedPty) {
          window.bind(targetTabId, leafId, movedPty)
        }
        const records = { ...window.session.sleepingAgentSessionsByPaneKey }
        const record = records[`${sourceTabId}:${leafId}`]
        if (record) {
          delete records[`${sourceTabId}:${leafId}`]
          records[`${targetTabId}:${leafId}`] = {
            ...record,
            paneKey: `${targetTabId}:${leafId}`,
            tabId: targetTabId
          }
          window.setSleeping(records)
        }
        source.leaves.delete(leafId)
        model.set(targetTabId, {
          worktreeId: source.worktreeId,
          leaves: new Map([[leafId, pane]])
        })
        save()
        break
      }
      case 'pty_exit': {
        const target = pick(panes().filter(({ pane }) => pane.ptyId))
        if (!target) {
          continue
        }
        log.push(`${op} ${target.tabId}:${target.leafId}`)
        // Main keeps an exited pane's binding; only the window's live id goes.
        window.setTabPtyId(target.tabId, null)
        save()
        break
      }
      case 'respawn': {
        const target = pick(panes())
        if (!target) {
          continue
        }
        const ptyId = ids.pty(target.tab.worktreeId)
        log.push(`${op} ${target.tabId}:${target.leafId} ${ptyId}`)
        const sleeping = target.pane.sleeping
        await bind(target.tab.worktreeId, target.tabId, target.leafId, ptyId)
        target.tab.leaves.get(target.leafId)!.sleeping = sleeping
        save()
        break
      }
      case 'sleep':
      case 'wake': {
        const target = pick(panes().filter(({ pane }) => pane.sleeping === (op === 'wake')))
        if (!target) {
          continue
        }
        log.push(`${op} ${target.tabId}:${target.leafId}`)
        const paneKey = `${target.tabId}:${target.leafId}`
        const records = { ...window.session.sleepingAgentSessionsByPaneKey }
        if (op === 'sleep') {
          records[paneKey] = sleepingRecord(target.tab.worktreeId, target.tabId, target.leafId)
        } else {
          delete records[paneKey]
        }
        window.setSleeping(records)
        target.pane.sleeping = op === 'sleep'
        save()
        break
      }
      case 'client_close_tab': {
        const tabId = pick([...model.keys()])
        if (!tabId) {
          continue
        }
        const ticks = Math.floor(random() * 4)
        log.push(`${op} ${tabId} stale-save+${ticks}`)
        const { worktreeId } = model.get(tabId)!
        // Race paired-client close against a renderer snapshot that still contains the tab.
        const [refusal] = await Promise.all([
          store.runDurableMutation(
            labeled(
              'client close',
              closeMutation(worktreeId, { kind: 'tab', tabId }, { reason: 'user' })
            )
          ),
          staleSave(window.snapshot(), ticks)
        ])
        expect(refusal).toBeUndefined()
        window.removeTab(tabId)
        model.delete(tabId)
        save()
        break
      }
      case 'client_split': {
        const target = pick(panes().filter(({ pane }) => pane.ptyId))
        if (!target) {
          continue
        }
        const { worktreeId } = target.tab
        const leafId = ids.leaf()
        const ptyId = ids.pty(worktreeId)
        const ticks = Math.floor(random() * 4)
        log.push(`${op} ${target.tabId}:${target.leafId} → ${leafId} ${ptyId} stale-save+${ticks}`)
        // Race runtime split admission/binding against a renderer save that lacks the new pane.
        writer = 'host split'
        const [bound] = await Promise.all([
          store
            .admitTerminalPane({
              type: 'splitPane',
              workspace: worktreeId,
              tabId: target.tabId,
              leafId: target.leafId,
              direction: 'vertical',
              newLeafId: leafId
            })
            .then(() =>
              store.persistPtyBinding({
                worktreeId,
                tabId: target.tabId,
                leafId,
                ptyId,
                mayCreate: false,
                expectedSourceBinding: {
                  tabId: target.tabId,
                  leafId: target.leafId,
                  ptyId: target.pane.ptyId!
                }
              })
            ),
          staleSave(window.snapshot(), ticks)
        ])
        expect(bound).toBe(true)
        const layout = store.getWorkspaceSession().terminalLayoutsByTabId[target.tabId]!
        window.setLayout(target.tabId, layout.root!, layout.ptyIdsByLeafId ?? {})
        target.tab.leaves.set(leafId, { ptyId, sleeping: false })
        save()
        break
      }
      case 'exit_retire': {
        // A sleeping pane has no process left to exit.
        const target = pick(panes().filter(({ pane }) => pane.ptyId && !pane.sleeping))
        if (!target) {
          continue
        }
        const ticks = Math.floor(random() * 4)
        log.push(`${op} ${target.tabId}:${target.leafId} stale-save+${ticks}`)
        writer = 'exit retire'
        await Promise.all([
          retireExitedPane(store, {
            worktreeId: target.tab.worktreeId,
            parentTabId: target.tabId,
            leafId: target.leafId,
            ptyId: target.pane.ptyId!
          }),
          staleSave(window.snapshot(), ticks)
        ])
        target.tab.leaves.delete(target.leafId)
        if (target.tab.leaves.size === 0) {
          window.removeTab(target.tabId)
          model.delete(target.tabId)
        } else {
          windowDropsPane(target.tabId, target.leafId)
        }
        save()
        break
      }
      case 'restart':
      case 'quit_restart': {
        log.push(op)
        await reopen(op === 'quit_restart')
        break
      }
    }
    const context = `seed ${seed}, step ${step}:\n${log.join('\n')}`
    expect(writeBreaches, context).toEqual([])
    const session = store.getWorkspaceSession()
    expectLayoutRules(session, previous, context)
    previous = structuredClone(session)
    expect(projectedTopology(session), context).toEqual(expectedTopology(model))
  }

  await reopen(false)
  const context = `seed ${seed}, after reopen:\n${log.join('\n')}`
  expectLayoutRules(store.getWorkspaceSession(), previous, context)
  expect(projectedTopology(store.getWorkspaceSession()), context).toEqual(expectedTopology(model))
  expect(writeBreaches, context).toEqual([])
  unwatchWrites()
  await store.freezeWritesAsync()
  return log
}

describe('terminal layout model (main session)', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps one tab per pane, one pane per terminal, and the expected layout across random gestures', async () => {
    const ranOps = new Set<string>()
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const log = await runSeed(FIRST_SEED + iteration)
      for (const entry of log) {
        ranOps.add(entry.split(' ')[0]!)
      }
    }
    // Require all gestures so a passing seed set cannot quietly omit operations.
    if (ITERATIONS >= 6) {
      expect([...ranOps].sort()).toEqual([...new Set(OPS)].sort())
    }
  }, 60_000)
})
