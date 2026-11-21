// A failed launch must not project as a completed turn: the exit signal on the PTY record
// outranks the lingering idle title when the process never reached working/permission (#7047).
import { describe, expect, it } from 'vitest'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

const PANE = 'pane-7047'

const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab-1::leaf-1',
  parentTabId: 'tab-1',
  leafId: 'leaf-1',
  title: 'Codex',
  launchAgent: 'codex',
  isActive: true
}

const HOST = {
  getPaneKey: () => PANE,
  getLeaf: () => null,
  getTrackedTitle: () => null
}

/** The fields the builder's title fallback actually reads off a PTY record. */
type BuilderPtyFixture = Pick<
  RuntimePtyWorktreeRecord,
  | 'ptyId'
  | 'worktreeId'
  | 'launchAgent'
  | 'foregroundAgent'
  | 'connected'
  | 'lastExitCode'
  | 'lastAgentStatus'
  | 'lastOscTitle'
  | 'lastOscTitleAt'
  | 'lastOscTitleEpochMs'
  | 'title'
  | 'titleUpdatedAt'
  | 'titleObservedAtEpochMs'
  | 'lastAgentStatusStartedAtEpochMs'
  | 'lastAgentStatusRichInvalidatedAtEpochMs'
  | 'lastOutputAt'
> &
  Partial<RuntimePtyWorktreeRecord>

const asPty = (fixture: BuilderPtyFixture): RuntimePtyWorktreeRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: BuilderPtyFixture pins every field the fallback reads.
  fixture as unknown as RuntimePtyWorktreeRecord

/** A launched-but-failed Codex agent: the shell reported `command not found` (exit 127) and the
 *  launch never produced a turn — only an idle-classified title lingers on the record. */
function makeLaunchedCodexPty(
  overrides: Partial<RuntimePtyWorktreeRecord> = {}
): RuntimePtyWorktreeRecord {
  const now = 1_700_000_000_000
  return asPty({
    ptyId: 'pty-codex-missing',
    worktreeId: 'repo-1::/tmp/worktree-a',
    launchAgent: 'codex',
    foregroundAgent: null,
    connected: true,
    lastExitCode: 127,
    lastAgentStatus: 'idle',
    lastOscTitle: 'Codex',
    lastOscTitleAt: now,
    lastOscTitleEpochMs: now,
    title: 'Codex',
    titleUpdatedAt: now,
    titleObservedAtEpochMs: now,
    lastAgentStatusStartedAtEpochMs: now,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOutputAt: now,
    ...overrides
  })
}

const project = (pty: RuntimePtyWorktreeRecord) =>
  buildRuntimeMobileAgentStatus(pty, TAB, 'handle-1', null, () => [], HOST)

describe('buildRuntimeMobileAgentStatus — the PTY exit signal outranks the idle title (#7047)', () => {
  it('suppresses the row for a launched agent whose CLI never ran (exit 127)', () => {
    expect(project(makeLaunchedCodexPty())).toEqual({})
  })

  it('still projects done for a clean zero exit', () => {
    expect(project(makeLaunchedCodexPty({ lastExitCode: 0 }))).toMatchObject({
      agentStatus: { state: 'done' }
    })
  })

  it('keeps the idle-title derivation while the process has not exited yet', () => {
    expect(project(makeLaunchedCodexPty({ lastExitCode: null }))).toMatchObject({
      agentStatus: { state: 'done' }
    })
  })

  it('a live working status still outranks the exit signal', () => {
    expect(project(makeLaunchedCodexPty({ lastAgentStatus: 'working' }))).toMatchObject({
      agentStatus: { state: 'working' }
    })
  })

  it('a permission wait still outranks the exit signal', () => {
    expect(project(makeLaunchedCodexPty({ lastAgentStatus: 'permission' }))).toMatchObject({
      agentStatus: { state: 'blocked' }
    })
  })
})
