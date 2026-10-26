import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { reportWindowSaveDrift } from './window-save-divergence'

function session(tabs: { id: string; title?: string }[]): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: tabs.map((tab, index) => {
        const leaves: [string, string?][] = [[leaf(index + 1)]]
        return { ...tab, leaves }
      })
    }
  ])
}

function save(stored: WorkspaceSessionState, next: WorkspaceSessionState, hostId = 'local') {
  reportWindowSaveDrift(stored, next, hostId, 'session:set')
  return next
}

describe('reportWindowSaveDrift', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let logDir: string | null = null

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'orca-divergence-'))
    vi.stubEnv('ORCA_LAYOUT_SAVE_DIVERGENCE_LOG', join(logDir, 'divergence.jsonl'))
  })

  afterEach(() => {
    warn.mockClear()
    vi.unstubAllEnvs()
    if (logDir) {
      rmSync(logDir, { recursive: true, force: true })
      logDir = null
    }
  })

  it('stays quiet for a save that leaves main’s layout as it is', () => {
    const tabs = [{ id: 'tab-a' }, { id: 'tab-b' }]

    expect(save(session(tabs), session(tabs))).toEqual(session(tabs))
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports tabs the save added or dropped and their group order', () => {
    const logPath = join(logDir!, 'divergence.jsonl')

    const next = session([{ id: 'tab-b', title: 'renamed' }, { id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), next)).toBe(next)

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n')
    const logged = JSON.parse(line!)
    expect(logged).toMatchObject({ source: 'session:set', partition: 'local', workspace: GIT_KEY })
    expect(logged.paths).toEqual(
      expect.arrayContaining([
        'tab tab-a removed',
        'tab tab-c added',
        'group group-1 changed: tabOrder'
      ])
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reports a reorder of the same tabs', () => {
    save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), session([{ id: 'tab-b' }, { id: 'tab-a' }]))

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        paths: expect.arrayContaining(['group group-1 changed: tabOrder'])
      })
    )
  })

  it('never throws when its log cannot be written', () => {
    vi.stubEnv(
      'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG',
      join(tmpdir(), 'orca-missing-dir', 'x', 'log.jsonl')
    )
    const next = session([{ id: 'tab-c' }])

    expect(save(session([{ id: 'tab-a' }]), next)).toBe(next)
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] save divergence log write failed:',
      expect.anything()
    )
  })

  it('reports a pane record the save changed, which the published layout does not carry', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      titlesByLeafId: { [leaf(1)]: 'build' }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: [`leaf ${leaf(1)} added`] })
    )
  })

  it('checks nothing without its log, and never throws when the check fails', () => {
    vi.stubEnv('ORCA_LAYOUT_SAVE_DIVERGENCE_LOG', '')
    save(session([{ id: 'tab-a' }]), session([{ id: 'tab-c' }]))
    expect(warn).not.toHaveBeenCalled()

    vi.stubEnv('ORCA_LAYOUT_SAVE_DIVERGENCE_LOG', join(logDir!, 'divergence.jsonl'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed stored copy is the case under test.
    expect(() => save(null as never, session([{ id: 'tab-a' }]))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] save divergence check failed:',
      expect.anything()
    )
  })

  it('leaves out panes only rebound to their terminals', () => {
    const bound = (ptyId: string): WorkspaceSessionState => {
      const result = session([{ id: 'tab-a' }, { id: 'tab-b' }])
      result.terminalLayoutsByTabId['tab-a'] = {
        ...result.terminalLayoutsByTabId['tab-a']!,
        ptyIdsByLeafId: { [leaf(1)]: ptyId }
      }
      return result
    }
    const next = bound('pty-2')
    next.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()

    save(bound('pty-1'), next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: ['group group-1 changed: tabOrder'] })
    )
  })

  // Main-owned fields may legitimately outrun renderer snapshots and must not report drift.
  it('stays quiet for records main keeps through its own writes', () => {
    const key = 'repo-1::/Users/dev/notes'
    const stored = session([{ id: 'tab-a' }])
    const bound = structuredClone(stored)
    bound.terminalLayoutsByTabId['tab-a'] = {
      ...bound.terminalLayoutsByTabId['tab-a']!,
      ptyIdsByLeafId: { [leaf(1)]: 'pty-1' }
    }

    save(stored, bound)
    save(emptySession(), {
      ...emptySession(),
      defaultTerminalTabsAppliedByWorktreeId: { [key]: true },
      tabsByWorktree: { [key]: [] },
      closedTerminalTabTombstonesByTabId: { 'tab-x': { worktreeId: key, closedAt: 1 } },
      unifiedTabs: { [key]: [] }
    })

    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet for a save that only names a workspace with nothing in it', () => {
    const key = 'repo-1::/Users/dev/empty'
    const next = { ...emptySession(), unifiedTabs: { [key]: [] }, tabGroups: { [key]: [] } }

    save(emptySession(), next)
    save(next, emptySession())

    expect(warn).not.toHaveBeenCalled()
  })

  it('still reports a workspace with tabs that the save adds or drops', () => {
    save(emptySession(), session([{ id: 'tab-a' }]))
    save(session([{ id: 'tab-a' }]), emptySession())

    for (const path of ['workspace added', 'workspace removed']) {
      expect(warn).toHaveBeenCalledWith(
        '[layout-owner] window save changed main layout:',
        'session:set',
        expect.objectContaining({ workspace: GIT_KEY, paths: expect.arrayContaining([path]) })
      )
    }
  })

  it('reports a save that drops a terminal tab’s tab-bar entry but keeps its row', () => {
    const stored = session([{ id: 'tab-a' }, { id: 'tab-b' }])
    const next = structuredClone(stored)
    next.unifiedTabs![GIT_KEY] = next.unifiedTabs![GIT_KEY]!.filter((tab) => tab.id !== 'tab-b')

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: GIT_KEY,
        paths: expect.arrayContaining(['terminal tab-b tab-bar entry removed'])
      })
    )
  })

  it('stays quiet for a save that carries no tab bar for the workspace yet', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    delete next.unifiedTabs![GIT_KEY]

    save(stored, next)

    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a save whose pane tree differs from main’s', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: leaf(1) },
        second: { type: 'leaf', leafId: leaf(2) }
      }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: GIT_KEY,
        paths: expect.arrayContaining(['tab tab-a changed: panes'])
      })
    )
  })

  it('logs main’s and the save’s pane trees for a pane tree difference', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: leaf(1) },
        second: { type: 'leaf', leafId: leaf(2) }
      }
    }

    save(stored, next)

    const logged = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(logged.paths).toEqual(['tab tab-a changed: panes'])
    expect(logged.values).toEqual([
      {
        record: 'tab tab-a',
        field: 'panes',
        before: { root: { type: 'leaf', leafId: leaf(1) } },
        after: {
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { type: 'leaf', leafId: leaf(1) },
            second: { type: 'leaf', leafId: leaf(2) }
          }
        }
      },
      {
        record: 'tab tab-a',
        field: 'ptys',
        before: [{ leafId: leaf(1), ptyId: null }],
        after: [
          { leafId: leaf(1), ptyId: null },
          { leafId: leaf(2), ptyId: null }
        ]
      }
    ])
  })

  it('logs the terminal each pane is bound to on both sides of a pane change', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    // Daemon IDs embed paths that can exceed ordinary ID lengths.
    const mainPty = `${GIT_KEY}/${'nested/'.repeat(10)}@@a1b2c3d4`
    const stored = session([{ id: 'tab-a' }])
    stored.terminalLayoutsByTabId['tab-a'] = {
      ...stored.terminalLayoutsByTabId['tab-a']!,
      ptyIdsByLeafId: { [leaf(1)]: mainPty }
    }
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      chatLeafId: leaf(1),
      ptyIdsByLeafId: { [leaf(1)]: 'pty-window' }
    }

    save(stored, next)

    const logged = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(logged.paths).toEqual(['tab tab-a changed: panes'])
    expect(logged.values).toContainEqual({
      record: 'tab tab-a',
      field: 'ptys',
      before: [{ leafId: leaf(1), ptyId: mainPty }],
      after: [{ leafId: leaf(1), ptyId: 'pty-window' }]
    })
  })

  it('logs a pane main and the save bind to different terminals within a changed tree', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const stored = session([{ id: 'tab-a' }])
    stored.terminalLayoutsByTabId['tab-a'] = {
      ...stored.terminalLayoutsByTabId['tab-a']!,
      ptyIdsByLeafId: { [leaf(1)]: 'pty-1' }
    }
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: leaf(1) },
        second: { type: 'leaf', leafId: leaf(2) }
      },
      ptyIdsByLeafId: { [leaf(1)]: 'pty-2', [leaf(2)]: 'p'.repeat(300) }
    }

    save(stored, next)

    const logged = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(logged.values).toContainEqual({
      record: 'tab tab-a',
      field: 'ptys',
      before: [{ leafId: leaf(1), ptyId: 'pty-1' }],
      after: [
        { leafId: leaf(1), ptyId: 'pty-2' },
        { leafId: leaf(2), ptyId: '<text 300>' }
      ]
    })
  })

  it('logs a changed title’s length, never its text', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const secret = 'cat ~/.ssh/id_ed25519'

    save(session([{ id: 'tab-a' }]), session([{ id: 'tab-a', title: secret }]))

    const text = readFileSync(logPath, 'utf8')
    expect(text).not.toContain(secret)
    expect(JSON.parse(text.trim()).values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: 'tab tab-a',
          field: 'terminal',
          after: { defaultTitle: `<text ${secret.length}>` }
        })
      ])
    )
  })

  it('logs only the size of a pane’s resume record, which holds its prompt and launch env', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      titlesByLeafId: { [leaf(1)]: 'build' }
    }
    const record: SleepingAgentSessionRecord = {
      paneKey: `tab-a:${leaf(1)}`,
      worktreeId: GIT_KEY,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-secret-id' },
      prompt: 'fix the login bug',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: { agentArgs: '', agentEnv: { type: 'env-secret-value' } }
    }
    stored.sleepingAgentSessionsByPaneKey = { [`tab-a:${leaf(1)}`]: record }
    next.sleepingAgentSessionsByPaneKey = {
      [`tab-a:${leaf(1)}`]: { ...record, prompt: 'a different prompt' }
    }

    save(stored, next)

    const text = readFileSync(logPath, 'utf8')
    for (const secret of [
      'login bug',
      'different prompt',
      'session-secret',
      'env-secret',
      'build'
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(JSON.parse(text.trim()).values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ record: `leaf ${leaf(1)}`, field: 'title', after: '<text 5>' })
      ])
    )
  })

  it('logs both sides of each change when many panes change at once', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const tabs = Array.from({ length: 4 }, (_, index) => ({ id: `tab-${index}` }))
    const stored = session(tabs)
    const next = structuredClone(stored)
    const split = (id: number) => ({
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: leaf(id) },
      second: { type: 'leaf' as const, leafId: `${id}-b` }
    })
    for (const [index, tab] of tabs.entries()) {
      next.terminalLayoutsByTabId[tab.id] = {
        ...next.terminalLayoutsByTabId[tab.id]!,
        root: { type: 'split', direction: 'horizontal', first: split(index + 1), second: split(9) }
      }
    }

    save(stored, next)

    const { values } = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(values).toHaveLength(8)
    expect(JSON.stringify(values)).not.toContain('…')
  })

  it('cuts a long tab order down to its first ids and a count', () => {
    const logPath = join(logDir!, 'divergence.jsonl')
    const tabs = Array.from({ length: 30 }, (_, index) => ({ id: `tab-${index}` }))

    save(session(tabs), session(tabs.toReversed()))

    const logged = JSON.parse(readFileSync(logPath, 'utf8').trim())
    const order = logged.values.find((value: { field: string }) => value.field === 'tabOrder')
    expect(order.before).toEqual([
      'tab-0',
      'tab-1',
      'tab-2',
      'tab-3',
      'tab-4',
      'tab-5',
      'tab-6',
      'tab-7',
      '+22 more'
    ])
  })

  it('leaves a paired server’s partition alone: its layout is the server’s', () => {
    const next = session([{ id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }]), next, 'runtime:env-1')).toBe(next)
    expect(warn).not.toHaveBeenCalled()
  })
})
