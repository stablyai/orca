import { vi } from 'vitest'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-send-contract'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { AgentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import type { LaunchedAgentForeground } from '../runtime/launched-agent-foreground'
import type { AgentLaunchPublishedSurface } from '../agent-launch/agent-launch-execution'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { AgentSessionResumeResult } from '../runtime/session-lifecycle/projection/resume-agent-session-in-workspace'
import type { ConversationTerminal } from './external-conversation-seam'
import type { ConversationLauncher } from './external-conversation-start'

export const WORKTREE = 'repo-1::/work/a'
export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
export const REOPENED_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'
export const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }
export const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/work',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

type LinkRow = { externalConversations?: unknown; hostId?: ExecutionHostId }

/** Model canonical host rows separately from the locator map that keeps the first same-path host. */
export function fakeLinkStore(repos: Repo[] = [LOCAL_REPO]) {
  const byHost = new Map<ExecutionHostId, Record<string, LinkRow>>()
  const legacy: Record<string, LinkRow> = {}
  const folders: (LinkRow & { id: string })[] = []
  const writes: HostWorktreeTarget[] = []
  const rows = (hostId: ExecutionHostId): Record<string, LinkRow> => {
    const existing = byHost.get(hostId)
    if (existing) {
      return existing
    }
    const created: Record<string, LinkRow> = {}
    byHost.set(hostId, created)
    return created
  }
  const put = (id: string, hostId: ExecutionHostId, row: Omit<LinkRow, 'hostId'>): void => {
    const next = { ...rows(hostId)[id], ...row, hostId }
    rows(hostId)[id] = next
    if (!legacy[id] || legacy[id].hostId === hostId) {
      legacy[id] = next
    }
  }
  const remove = (id: string, hostId: ExecutionHostId = 'local'): void => {
    delete rows(hostId)[id]
    if (legacy[id]?.hostId === hostId) {
      delete legacy[id]
    }
  }
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => legacy,
    getAllWorktreeMetaForHost: (hostId: ExecutionHostId) => rows(hostId),
    getWorktreeMeta: (id: string) => legacy[id],
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) => rows(hostId)[id],
    setWorktreeMeta: (target: HostWorktreeTarget, updates: { externalConversations: unknown }) => {
      writes.push(target)
      put(target.id, target.hostId, updates)
    },
    getFolderWorkspace: (id: string) => folders.find((folder) => folder.id === id),
    getFolderWorkspaces: () => folders,
    updateFolderWorkspace: (id: string, updates: { externalConversations: unknown }) => {
      const folder = folders.find((candidate) => candidate.id === id)
      if (folder) {
        folder.externalConversations = updates.externalConversations
      }
    }
  } satisfies ExternalConversationLinkStore
  const row = (id: string, hostId: ExecutionHostId = 'local'): LinkRow | undefined =>
    rows(hostId)[id]
  return { store, row, put, remove, folders, writes }
}

export function launchResult(
  prompt: 'handed-to-terminal' | 'not-delivered' | 'unconfirmed' | null,
  worktreeId = WORKTREE,
  paneKey = PANE
): AgentLaunchResult {
  return {
    outcome: { kind: 'terminal', handle: 'term-1', paneKey },
    worktreeId,
    receipt: {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'terminal'
    },
    ...(prompt ? { prompt: { delivery: 'submit', outcome: prompt } } : {})
  }
}

export function fakeLauncher(
  settle: () => Promise<AgentLaunchResult>,
  workspace: AgentPaneWorkspace = { worktreeId: WORKTREE, sshHostId: null },
  publish = true
) {
  const launch = vi.fn(
    async (
      _input: unknown,
      onSurfacePublished: (surface: AgentLaunchPublishedSurface) => void,
      _signal?: AbortSignal
    ): Promise<AgentLaunchResult> => {
      if (publish) {
        onSurfacePublished(launchResult(null, workspace.worktreeId))
      }
      return settle()
    }
  )
  const launcher: ConversationLauncher = { launch, paneWorkspace: async () => workspace }
  return { launcher, launch }
}

type WriteOptions = {
  beforeWrite?: (ptyId: string) => unknown
  signal?: AbortSignal
  onPermission?: 'refuse' | 'wait'
  expectedBinding?: { ptyId: string; processIncarnation: string }
}

export function sessionRow(
  paneKey: string,
  connectionId: string | null = null,
  session = SESSION
): AgentStatusIpcPayload {
  return {
    paneKey,
    connectionId,
    agentType: 'claude',
    state: 'done',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: session
  }
}

/** Preserve writer ordering: approval wait, binding fence, guard, abort check, then write. */
export function fakeTerminal() {
  const state: {
    ptyId: string | null
    paneKey: string
    incarnation: number
    blocked: boolean
    rows: AgentStatusIpcPayload[] | null
    liveness: PtyLivenessVerdict | null
  } = {
    ptyId: 'pty-1',
    paneKey: PANE,
    incarnation: 1,
    blocked: false,
    rows: null,
    liveness: null
  }
  const current = (): string =>
    `inc-${state.ptyId}${state.incarnation > 1 ? `-${state.incarnation}` : ''}`
  const writes: string[] = []
  /** Raw keys written outside the prompt writer: prompt answers. */
  const keys: string[] = []
  const waiters = new Set<(error?: Error) => void>()
  const hold = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      const settle = (error?: Error): void => {
        waiters.delete(settle)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const onAbort = (): void => settle(new Error('request_aborted'))
      signal?.addEventListener('abort', onAbort)
      waiters.add(settle)
    })
  const sendTerminalAgentPrompt = vi.fn(
    async (handle: string, prompt: string, options: WriteOptions): Promise<RuntimeTerminalSend> => {
      if (state.blocked) {
        if (options.onPermission !== 'wait') {
          throw new Error('agent_prompt_blocked')
        }
        await hold(options.signal)
      }
      const expected = options.expectedBinding
      if (
        expected &&
        (expected.ptyId !== state.ptyId || expected.processIncarnation !== current())
      ) {
        throw new Error('terminal_handle_stale')
      }
      await options.beforeWrite?.(state.ptyId ?? '')
      if (options.signal?.aborted) {
        throw new Error('request_aborted')
      }
      writes.push(prompt)
      return { handle, accepted: true, bytesWritten: 1 }
    }
  )
  const sendTerminal = vi.fn(
    async (
      handle: string,
      action: { text?: string },
      options: {
        beforeWrite?: (ptyId: string) => unknown
        reserveWrite?: (ptyId: string) => void
      }
    ): Promise<RuntimeTerminalSend> => {
      if (!state.ptyId) {
        throw new Error('terminal_not_writable')
      }
      await options.beforeWrite?.(state.ptyId)
      options.reserveWrite?.(state.ptyId)
      keys.push(action.text ?? '')
      return { handle, accepted: true, bytesWritten: 1, writeSettlement: { outcome: 'accepted' } }
    }
  )
  const resumeAgentSessionInWorkspace = vi.fn(
    async (
      _worktreeId: string,
      _request: { signal?: AbortSignal; mutationId: string }
    ): Promise<AgentSessionResumeResult> => ({ ok: false, reason: 'held_elsewhere' })
  )
  const ready: RuntimeTerminalWait = {
    handle: 'term-2',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  }
  const waitForFreshWorkerComposer = vi.fn(async () => ready)
  const terminal = {
    getTerminalHandleForPaneKey: (paneKey: string) =>
      paneKey === state.paneKey && state.ptyId ? (paneKey === PANE ? 'term-1' : 'term-2') : null,
    getTerminalPromptRequestBinding: () => {
      if (!state.ptyId) {
        throw new Error('terminal_not_writable')
      }
      return { ptyId: state.ptyId, processIncarnation: current(), generation: 1 }
    },
    sendTerminalAgentPrompt,
    sendTerminal,
    getPtyLivenessVerdict: (_ptyId: string) => state.liveness,
    readLaunchedAgentForeground: vi.fn(
      async (_ptyId: string): Promise<LaunchedAgentForeground> => 'agent'
    ),
    subscribeToTerminalData: () => () => {},
    getAgentStatusRowsForPane: (paneKey: string) =>
      state.rows ?? (paneKey === state.paneKey && state.ptyId ? [sessionRow(paneKey)] : []),
    resumeAgentSessionInWorkspace,
    waitForFreshWorkerComposer,
    waitForTerminal: vi.fn(async () => ready)
  } satisfies ConversationTerminal
  return {
    terminal,
    state,
    writes,
    keys,
    sendTerminal,
    sendTerminalAgentPrompt,
    resumeAgentSessionInWorkspace,
    waitForFreshWorkerComposer,
    reopenable() {
      resumeAgentSessionInWorkspace.mockImplementation(async () => {
        state.paneKey = REOPENED_PANE
        state.ptyId = 'pty-2'
        state.incarnation = 1
        return { ok: true, handle: 'term-2', paneKey: REOPENED_PANE, ptyId: 'pty-2' }
      })
    },

    held: () => waiters.size,
    answer() {
      state.blocked = false
      ;[...waiters].forEach((settle) => settle())
    },
    exit() {
      state.ptyId = null
      ;[...waiters].forEach((settle) => settle(new Error('terminal_not_writable')))
    },
    /** Replace the process without changing pane or PTY IDs, exercising the incarnation fence. */
    replace() {
      state.incarnation += 1
    }
  }
}
