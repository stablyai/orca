import type { BrowserWindow } from 'electron'
import { vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { finishPtyShutdown } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** A host with no native chats, so every saved resume is admitted, and the pane rows given. */
export type SavedResumeHost = {
  openAgentSessionRecordStore: () => Promise<AgentSessionRecordStore>
  getTerminalLaunchResult: Mock
  forgetRefusedSavedResume: Mock
  registerPty: Mock
  noteTerminalSpawnCommand: Mock
  reflowHeadlessTerminalToPtyGrid: Mock
  getAgentProviderSessionRows: () => readonly object[]
}

export function savedResumeHost(rows: () => readonly object[]): SavedResumeHost {
  return {
    openAgentSessionRecordStore: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these two members.
      ({
        listConversations: () => [],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
      }) as unknown as AgentSessionRecordStore,
    getTerminalLaunchResult: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    getAgentProviderSessionRows: rows
  }
}

export function savedResumeDeps(runtime: SavedResumeHost): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn reads only the members `host` provides.
    runtime: runtime as unknown as OrcaRuntimeService,
    store: undefined,
    getSettings: () => getDefaultSettings('/tmp'),
    adoptStablePane: async (args) => {
      await args.spawnFresh?.({ mustExist: false })
      return null
    },
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    assertWorkspaceAcceptsNewPty: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn never touches `mainWindow`.
    mainWindow: {} as BrowserWindow
  }
}
