import { ipcRenderer, type IpcRenderer, type IpcRendererEvent } from 'electron'

export type DebugStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated' | 'failed'

export type DebugRefusalReason =
  | 'debug_unavailable'
  | 'untrusted-renderer'
  | 'unknown-repo'
  | 'outside-worktree'
  | 'remote-workspace'
  | 'repo-not-enabled'
  | 'adapter-not-found'
  | 'adapter-not-approved'
  | 'launch-not-approved'
  | 'changed-since-preview'
  | 'already-debugging'
  | 'no-session'
  | 'unknown-breakpoint'
  | 'request-failed'
  // An agent (origin cli) tried to run code in, or drive, a session a person started.
  | 'human-session'
  | 'human-confirmation-required'
  // launch.json refusals from resolveLaunchSpec, passed through.
  | 'malformed'
  | 'unreadable'
  | 'not-found'
  | 'compound'
  | 'unknown-type'
  | 'unsupported-request'
  | 'unsupported-variable'
  | 'needs-file'
  | 'no-default'

export type DebugRefusal = { ok: false; reason: DebugRefusalReason; message: string }
export type DebugResult<T> = { ok: true; value: T } | DebugRefusal

export type DebugBreakpointAnswer = {
  state: 'verified' | 'pending' | 'failed' | 'unsupported'
  line?: number
  message?: string
}

export type DebugBreakpointWire = {
  id: string
  path: string
  line: number
  column?: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
  answer: DebugBreakpointAnswer
}

export type DebugExceptionFilterWire = { filter: string; label: string; default: boolean }
export type DebugThreadWire = { id: number; name: string }

export type DebugSnapshot = {
  seq: number
  worktreePath: string
  status: DebugStatus
  configName: string | null
  adapterId: string | null
  capabilities: Record<string, unknown>
  /** Non-null only with a thread to act on. */
  stopped: {
    reason: string
    threadId: number
    allThreadsStopped: boolean
    description?: string
  } | null
  threads: DebugThreadWire[]
  breakpoints: DebugBreakpointWire[]
  exceptionFilters: { available: DebugExceptionFilterWire[]; enabled: string[] }
  lastError: string | null
}

export type DebugOutputEvent = {
  worktreePath: string
  seq: number
  ts: number
  category: string
  text: string
}
export type DebugStateEvent = { kind: 'state'; seq: number; status: DebugStatus }
export type DebugEventsPage = {
  events: (DebugOutputEvent | DebugStateEvent)[]
  latestSeq: number
  /** Events after the requested seq were evicted from the ring. */
  truncated: boolean
}

/** What the confirmation shows before anything runs; mirrors main's LaunchRuns. */
export type DebugLaunchRunsWire = {
  program: unknown
  args: unknown
  cwd: unknown
  module: unknown
  python: unknown
  runtimeExecutable: unknown
  runtimeArgs: unknown
  envFile: unknown
  processId: unknown
  host: unknown
  port: unknown
  adapterBinary: string | null
  adapterArgs: string[] | null
  adapterRepoLocal: boolean
  env: { name: string; value: string | null; masked: boolean; dangerous: boolean }[]
  /** Every key the adapter receives (strings as written, the rest as JSON); command-running keys are dangerous. */
  allKeys: { name: string; value: string; dangerous: boolean }[]
  /** The envFile's entries, masked and flagged like env; its text is part of the approval hash. */
  envFileEntries: { name: string; value: string | null; masked: boolean; dangerous: boolean }[]
}

export type DebugLaunchPreview = {
  name: string
  configHash: string
  /** sha256 of configHash + the adapter approvalKey; approveLaunch and start take this one. */
  expectedHash: string
  runs: DebugLaunchRunsWire
  consoleForcedFrom?: string
  adapter: {
    id: string
    binaryPath: string
    args: string[]
    approvalKey: string
    repoLocal: boolean
  }
  approved: { repo: boolean; adapter: boolean; launch: boolean }
}

export type DebugAdapterDescription = {
  adapterId: string
  label: string
  languages: string[]
  transport: 'stdio' | 'socket' | 'tcp'
  binaryPath: string | null
  args: string[] | null
  approvalKey: string | null
  /** The binary is inside the worktree: anything that writes the repo can change what runs. */
  repoLocal: boolean
  hint: string | null
}

export type DebugLaunchConfigListing = {
  name: string
  kind: 'configuration' | 'compound'
  type: string
  request: string
  adapterId: string | null
  runnable: boolean
  refusal?: string
}

/** The renderer names the repo and worktree; main derives the root, host and adapter itself. */
export type DebugLaunchTarget = {
  repoId: string
  worktreePath: string
  configName?: string
  filePath?: string
  lineNumber?: number
  languageId?: string
}

/** Every per-session channel names its repo: main re-derives the root from it each call. */
export type DebugWorktree = { repoId: string; worktreePath: string }
export type DebugThreadTarget = DebugWorktree & { threadId: number }
export type DebugBreakpointFields = {
  line?: number
  column?: number
  enabled?: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
}
export type DebugStackFrameWire = {
  id: number
  name: string
  source?: { name?: string; path?: string; sourceReference?: number }
  line: number
  column: number
  presentationHint?: 'normal' | 'label' | 'subtle'
}
export type DebugScopeWire = {
  name: string
  presentationHint?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
  expensive: boolean
}
export type DebugVariableWire = {
  name: string
  value: string
  type?: string
  evaluateName?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
}
export type DebugEvaluateContext = 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables'

export type DebugApi = {
  /** With a worktree, repoLocal is computed against it. */
  describeAdapters: (params?: DebugWorktree) => Promise<DebugResult<DebugAdapterDescription[]>>
  listConfigs: (
    params: Pick<DebugLaunchTarget, 'repoId' | 'worktreePath'>
  ) => Promise<DebugResult<DebugLaunchConfigListing[]>>
  previewLaunch: (params: DebugLaunchTarget) => Promise<DebugResult<DebugLaunchPreview>>
  /** Main re-reads launch.json and stores the approvals only when its hash still equals expectedHash. */
  approveLaunch: (
    params: DebugLaunchTarget & { expectedHash: string }
  ) => Promise<DebugResult<DebugLaunchPreview>>
  start: (
    params: DebugLaunchTarget & { expectedHash?: string }
  ) => Promise<DebugResult<DebugSnapshot>>
  stop: (params: DebugWorktree) => Promise<DebugResult<DebugSnapshot>>
  restart: (params: DebugWorktree) => Promise<DebugResult<DebugSnapshot>>
  continue: (params: DebugThreadTarget) => Promise<DebugResult<null>>
  next: (params: DebugThreadTarget) => Promise<DebugResult<null>>
  stepIn: (params: DebugThreadTarget) => Promise<DebugResult<null>>
  stepOut: (params: DebugThreadTarget) => Promise<DebugResult<null>>
  pause: (params: DebugThreadTarget) => Promise<DebugResult<null>>
  threads: (params: DebugWorktree) => Promise<DebugResult<DebugThreadWire[]>>
  stackTrace: (
    params: DebugThreadTarget & { startFrame?: number; levels?: number }
  ) => Promise<DebugResult<{ stackFrames: DebugStackFrameWire[]; totalFrames?: number }>>
  scopes: (params: DebugWorktree & { frameId: number }) => Promise<DebugResult<DebugScopeWire[]>>
  variables: (
    params: DebugWorktree & { variablesReference: number; start?: number; count?: number }
  ) => Promise<DebugResult<DebugVariableWire[]>>
  evaluate: (
    params: DebugWorktree & { expression: string; frameId?: number; context?: DebugEvaluateContext }
  ) => Promise<DebugResult<{ result: string; type?: string; variablesReference: number }>>
  setVariable: (
    params: DebugWorktree & { variablesReference: number; name: string; value: string }
  ) => Promise<DebugResult<DebugVariableWire>>
  setExceptionFilters: (
    params: DebugWorktree & { filters: string[] }
  ) => Promise<DebugResult<DebugSnapshot>>
  addBreakpoint: (
    params: DebugWorktree & { path: string; line: number } & DebugBreakpointFields
  ) => Promise<DebugResult<DebugBreakpointWire>>
  updateBreakpoint: (
    params: DebugWorktree & { id: string; fields: DebugBreakpointFields }
  ) => Promise<DebugResult<DebugBreakpointWire>>
  removeBreakpoint: (params: DebugWorktree & { id: string }) => Promise<DebugResult<null>>
  /** Moves breakpoints by id after an edit, so conditions and enabled state survive. */
  setFileLines: (
    params: DebugWorktree & {
      path: string
      lines: { id: string; line: number }[]
    }
  ) => Promise<DebugResult<DebugBreakpointWire[]>>
  listBreakpoints: (params: DebugWorktree) => Promise<DebugResult<DebugBreakpointWire[]>>
  snapshot: (params: DebugWorktree) => Promise<DebugResult<DebugSnapshot>>
  eventsSince: (params: DebugWorktree & { seq: number }) => Promise<DebugResult<DebugEventsPage>>
  /** Starts the debug:state and debug:output pushes to this window. */
  subscribe: () => Promise<DebugResult<null>>
  onState: (listener: (snapshot: DebugSnapshot) => void) => () => void
  onOutput: (listener: (event: DebugOutputEvent) => void) => () => void
}

type DebugIpc = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

function listen<T>(ipc: DebugIpc, channel: string, listener: (event: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipc.on(channel, handler)
  return () => {
    ipc.removeListener(channel, handler)
  }
}

export function createDebugApi(ipc: DebugIpc): DebugApi {
  return {
    describeAdapters: (params) => ipc.invoke('debug:describeAdapters', params),
    listConfigs: (params) => ipc.invoke('debug:listConfigs', params),
    previewLaunch: (params) => ipc.invoke('debug:previewLaunch', params),
    approveLaunch: (params) => ipc.invoke('debug:approveLaunch', params),
    start: (params) => ipc.invoke('debug:start', params),
    stop: (params) => ipc.invoke('debug:stop', params),
    restart: (params) => ipc.invoke('debug:restart', params),
    continue: (params) => ipc.invoke('debug:continue', params),
    next: (params) => ipc.invoke('debug:next', params),
    stepIn: (params) => ipc.invoke('debug:stepIn', params),
    stepOut: (params) => ipc.invoke('debug:stepOut', params),
    pause: (params) => ipc.invoke('debug:pause', params),
    threads: (params) => ipc.invoke('debug:threads', params),
    stackTrace: (params) => ipc.invoke('debug:stackTrace', params),
    scopes: (params) => ipc.invoke('debug:scopes', params),
    variables: (params) => ipc.invoke('debug:variables', params),
    evaluate: (params) => ipc.invoke('debug:evaluate', params),
    setVariable: (params) => ipc.invoke('debug:setVariable', params),
    setExceptionFilters: (params) => ipc.invoke('debug:setExceptionFilters', params),
    addBreakpoint: (params) => ipc.invoke('debug:addBreakpoint', params),
    updateBreakpoint: (params) => ipc.invoke('debug:updateBreakpoint', params),
    removeBreakpoint: (params) => ipc.invoke('debug:removeBreakpoint', params),
    setFileLines: (params) => ipc.invoke('debug:setFileLines', params),
    listBreakpoints: (params) => ipc.invoke('debug:listBreakpoints', params),
    snapshot: (params) => ipc.invoke('debug:snapshot', params),
    eventsSince: (params) => ipc.invoke('debug:eventsSince', params),
    subscribe: () => ipc.invoke('debug:subscribe'),
    onState: (listener) => listen(ipc, 'debug:state', listener),
    // Main batches output (one message per 50 ms at most); the listener still sees one event at a time.
    onOutput: (listener) =>
      listen<DebugOutputEvent[]>(ipc, 'debug:output', (batch) => batch.forEach(listener))
  }
}

export const debugApi = createDebugApi(ipcRenderer)
