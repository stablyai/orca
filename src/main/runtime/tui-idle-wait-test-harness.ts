import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Centralize narrow wait-path fixtures and checked field contracts; wide unused runtime members stay confined to these doubles. */

/** The fields the tui-idle wait path actually reads off a PTY record. */
export type TuiIdlePtyFixture = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'lastAgentStatus' | 'lastOscTitle' | 'lastOutputAt' | 'tailBuffer' | 'preview'
> &
  Partial<RuntimePtyWorktreeRecord>

// Fixture types check every consumed field; other record members are inert here.
const asPty = (fixture: TuiIdlePtyFixture): RuntimePtyWorktreeRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TuiIdlePtyFixture pins every field the wait path reads.
  fixture as unknown as RuntimePtyWorktreeRecord

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

function makeStore(repoPath: string) {
  // Kept, not dropped: layout-owner builds read a terminal's pane from this session.
  let session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
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
  // Partial store/controller doubles fail loudly if the wait path reads missing members.
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; the wait path reads only the members defined above.
    makeStore(options.repoPath) as never
  )
  runtime.setPtyController({
    spawn: async () => ({ id: 'fixture-pty' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: options.getForegroundProcess,
    listProcesses: async () => [],
    hasPty: () => true
  })
  return runtime
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
