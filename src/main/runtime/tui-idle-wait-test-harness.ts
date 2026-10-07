import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/**
 * Shared fixtures for the tui-idle wait suites.
 *
 * Why a module rather than per-file helpers: the runtime's store, PTY controller and
 * terminal records are wide contracts (40 members on the controller alone) and the wait
 * path reads a handful of fields from each. Standing up a complete instance per test
 * would bury the behaviour under fixture noise, so the partial doubles are built once
 * here and every cast that needs is confined to this file.
 */

/** The fields the tui-idle wait path actually reads off a PTY record. */
export type TuiIdlePtyFixture = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'lastAgentStatus' | 'lastOscTitle' | 'lastOutputAt' | 'tailBuffer' | 'preview'
> &
  Partial<RuntimePtyWorktreeRecord>

/** The fields the tui-idle wait path actually reads off a leaf record. */
export type TuiIdleLeafFixture = Pick<
  RuntimeLeafRecord,
  | 'tabId'
  | 'leafId'
  | 'ptyId'
  | 'lastAgentStatus'
  | 'lastOscTitle'
  | 'lastOutputAt'
  | 'paneTitle'
  | 'tailBuffer'
  | 'preview'
> &
  Partial<RuntimeLeafRecord>

// The fixture types above pin every field the wait path reads; the remaining record
// members are inert here, and the compiler still checks the pinned ones at each call site.
const asPty = (fixture: TuiIdlePtyFixture): RuntimePtyWorktreeRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TuiIdlePtyFixture pins every field the wait path reads.
  fixture as unknown as RuntimePtyWorktreeRecord

const asLeaf = (fixture: TuiIdleLeafFixture): RuntimeLeafRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TuiIdleLeafFixture pins every field the wait path reads.
  fixture as unknown as RuntimeLeafRecord

export function makeTuiIdlePty(
  overrides: Partial<RuntimePtyWorktreeRecord> = {}
): RuntimePtyWorktreeRecord {
  return asPty({
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOscTitle: null,
    lastOutputAt: Date.now(),
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  })
}

export function makeTuiIdleLeaf(overrides: Partial<RuntimeLeafRecord> = {}): RuntimeLeafRecord {
  return asLeaf({
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOscTitle: null,
    lastOutputAt: Date.now(),
    paneTitle: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  })
}

function makeStore(repoPath: string) {
  return {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    getRepos: () => [
      {
        id: 'repo-1',
        path: repoPath,
        displayName: 'fixture',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => {},
    removeWorktreeMeta: () => {},
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => []
  }
}

export type TuiIdleRuntimeOptions = {
  repoPath: string
  getForegroundProcess: () => Promise<string | null>
}

/** A runtime wired with the narrowest store and controller the wait path needs. */
export function makeTuiIdleRuntime(options: TuiIdleRuntimeOptions): OrcaRuntimeService {
  // RuntimeStore and RuntimePtyController are wide contracts; the wait path calls only the
  // members provided here, and a missing one throws loudly rather than silently passing.
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; the wait path reads only the members defined above.
    makeStore(options.repoPath) as never
  )
  runtime.setPtyController(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial controller double; the wait path calls only the members listed here.
    {
      spawn: async () => ({ id: 'fixture-pty' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: options.getForegroundProcess,
      listProcesses: async () => [],
      hasPty: () => true
    } as never
  )
  return runtime
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
