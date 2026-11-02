import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/** Checks a window save of `next` against main's `stored` partition. */
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

  it('reports a tab the save added, dropped, renamed or moved', () => {
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

  // Main writes these itself (spawn, its default-tabs and close commands, D1); a save lagging them asks for nothing.
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

  it('leaves a paired server’s partition alone: its layout is the server’s', () => {
    const next = session([{ id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }]), next, 'runtime:env-1')).toBe(next)
    expect(warn).not.toHaveBeenCalled()
  })
})
