import { expect, it } from 'vitest'
import { publishTerminalCompletionSurface } from '../../../ipc/pty/pane/terminal-completion-surface'
import type { LegacyTerminalRestoreAttempt } from '../../../pty/legacy-terminal-restore-ownership'
import { resolveTerminalLaunchResult, terminalLaunchPublicFacts } from './terminal-launch-result'

it('keeps fresh launch facts when an accepted completion follows its moved pane through result copies', () => {
  const attempt: LegacyTerminalRestoreAttempt = {
    catalog: { ready: Promise.resolve(true), complete: true, finish: () => {} },
    readinessDeadline: 1000,
    workspace: 'workspace',
    tabId: 'source',
    leafId: 'leaf',
    revision: 0,
    closed: false,
    close: new AbortController()
  }
  const result = {
    id: 'workspace@@aabbccdd',
    incarnationId: 'incarnation',
    coldRestore: { scrollback: 'old screen', cwd: '/original', cols: 80, rows: 24 }
  }
  publishTerminalCompletionSurface(result, result, attempt, 'term_fresh')
  attempt.tabId = 'destination'
  const copied = { ...result }
  const launch = resolveTerminalLaunchResult(copied, {
    requireFreshPane: true,
    launchAgent: 'claude',
    launchToken: 'token',
    title: 'Fresh',
    viewMode: 'terminal'
  })
  expect(launch).toMatchObject({
    adoptedStablePane: false,
    surface: { terminalHandle: 'term_fresh', tabId: 'destination', leafId: 'leaf' },
    launchAgent: 'claude',
    launchToken: 'token',
    effectiveTitle: 'Fresh',
    effectiveViewMode: 'terminal'
  })
  expect(terminalLaunchPublicFacts(copied, launch.adoptedStablePane, null)).toMatchObject({
    coldRestore: { scrollback: 'old screen', cwd: '/original' }
  })
  attempt.closed = true
  expect(() => resolveTerminalLaunchResult(copied, {})).toThrow('terminal_pane_owner_changed')
})

it('keeps actual adoption authoritative and enforces a fresh-pane request', () => {
  const adopted = {
    id: 'workspace@@aabbccdd',
    stablePaneOwner: { handle: 'term_live', tabId: 'live-tab', leafId: 'live-leaf' }
  }
  expect(
    resolveTerminalLaunchResult(adopted, { launchAgent: 'claude', title: 'New' })
  ).toMatchObject({
    adoptedStablePane: true,
    surface: { terminalHandle: 'term_live', tabId: 'live-tab', leafId: 'live-leaf' },
    launchAgent: undefined,
    effectiveTitle: null
  })
  expect(() => resolveTerminalLaunchResult(adopted, { requireFreshPane: true })).toThrow()
  expect(resolveTerminalLaunchResult({ id: 'ordinary' }, { requireFreshPane: true })).toMatchObject(
    {
      adoptedStablePane: false,
      surface: undefined
    }
  )
})
