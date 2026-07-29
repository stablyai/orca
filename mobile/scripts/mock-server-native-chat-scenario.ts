import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import type { AgentStatusEntry } from '../../src/shared/agent-status-types'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../src/shared/runtime-types'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

// Why: native chat needs a live agent tab, an empty-but-subscribed transcript,
// and a terminal send path whose acceptance can be flipped mid-session.
// Restarting the server re-keys E2EE (forcing a re-pair), so send behaviour is
// read from a control file on every request instead of an env var.
const SEND_MODE_FILE = process.env.MOCK_SEND_MODE_FILE ?? join(tmpdir(), 'orca-mock-send-mode')
const TERMINAL_LIST_MODE_FILE =
  process.env.MOCK_TERMINAL_LIST_MODE_FILE ?? join(tmpdir(), 'orca-mock-terminal-list-mode')
// Write `dead` here to reproduce a gone PTY: the host answers with `subscribed`
// then `end`, which is the shape the rearm bound and terminal prune react to.
const TERMINAL_STREAM_MODE_FILE =
  process.env.MOCK_TERMINAL_STREAM_MODE_FILE ?? join(tmpdir(), 'orca-mock-terminal-stream-mode')
const TERMINAL_HANDLE = 'chat-term-1'
const TAB_ID = 'chat-tab-1'
const SESSION_ID = 'mock-chat-session'
const TRANSCRIPT_PATH = join(tmpdir(), 'mock-transcript.jsonl')
const MOCK_IMAGE_PATH = join(tmpdir(), 'mock-image.png')

function readControl(file: string): string {
  try {
    return readFileSync(file, 'utf-8').trim()
  } catch {
    // Default to the happy path when the control file is absent.
    return ''
  }
}

const tabsSnapshots = new Map<string, { version: number; signature: string }>()
const agentStatus: AgentStatusEntry = {
  state: 'done',
  prompt: '',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  agentType: 'claude',
  paneKey: `${TAB_ID}:leaf-1`,
  terminalHandle: TERMINAL_HANDLE,
  stateHistory: [],
  providerSession: {
    key: 'session_id',
    id: SESSION_ID,
    transcriptPath: TRANSCRIPT_PATH
  }
}

function buildTab(): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: TAB_ID,
    title: 'Claude Code',
    parentTabId: TAB_ID,
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    status: 'ready',
    terminal: TERMINAL_HANDLE,
    launchAgent: 'claude',
    agentStatus,
    viewMode: 'chat',
    isActive: true
  }
}

// Versions are per-worktree and only advance on real content change, so the
// mock can't fake a re-render heartbeat the runtime would never send.
function buildTabsResult(worktree: string): RuntimeMobileSessionTabsResult {
  const result: RuntimeMobileSessionTabsResult = {
    worktree,
    publicationEpoch: 'mock-epoch-1',
    snapshotVersion: 0,
    activeGroupId: 'group-1',
    activeTabId: TAB_ID,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs: [buildTab()]
  }
  const signature = JSON.stringify(result)
  const previous = tabsSnapshots.get(worktree)
  const current =
    previous?.signature === signature
      ? previous
      : { version: (previous?.version ?? 0) + 1, signature }
  tabsSnapshots.set(worktree, current)
  result.snapshotVersion = current.version
  return result
}

function tabsResultIfChanged(worktree: string): RuntimeMobileSessionTabsResult | null {
  const before = tabsSnapshots.get(worktree)?.version
  const result = buildTabsResult(worktree)
  return result.snapshotVersion === before ? null : result
}

function worktreeOf(request: RpcRequest): string {
  const raw = request.params?.worktree
  return typeof raw === 'string' ? raw : 'id:mock-worktree'
}

// Why: unsubscribe correlates by worktree, not request id, and a socket that
// navigates A->B->A would otherwise stack one push loop per subscribe.
const tabsPushLoops = new Map<WebSocket, Map<string, ReturnType<typeof setInterval>>>()

function stopTabsPushLoop(ws: WebSocket, worktree: string): void {
  const loops = tabsPushLoops.get(ws)
  const existing = loops?.get(worktree)
  if (existing !== undefined) {
    clearInterval(existing)
    loops?.delete(worktree)
  }
}

function startTabsPushLoop(ws: WebSocket, worktree: string, push: () => void): void {
  stopTabsPushLoop(ws, worktree)
  const interval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      stopTabsPushLoop(ws, worktree)
      return
    }
    push()
  }, 3000)
  let loops = tabsPushLoops.get(ws)
  if (!loops) {
    loops = new Map()
    tabsPushLoops.set(ws, loops)
    ws.once('close', () => {
      for (const timer of tabsPushLoops.get(ws)?.values() ?? []) {
        clearInterval(timer)
      }
      tabsPushLoops.delete(ws)
    })
  }
  loops.set(worktree, interval)
}

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse
type Failure = (id: string, code: string, message: string) => RpcResponse

/** Mock backend for the native-chat surface: session tabs, an empty transcript
 *  snapshot, terminal send, and image upload. Opt-in via MOCK_NATIVE_CHAT=1
 *  because it replaces the default terminal fixtures. No transcript or terminal
 *  output frames are pushed. Returns false for methods it does not own. */
export function handleMockNativeChatRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  error: Failure,
  ws: WebSocket
): boolean {
  if (process.env.MOCK_NATIVE_CHAT !== '1') {
    return false
  }
  switch (request.method) {
    case 'session.tabs.list':
      respond(success(request.id, buildTabsResult(worktreeOf(request))))
      return true

    case 'session.tabs.subscribe': {
      const worktree = worktreeOf(request)
      respond(success(request.id, buildTabsResult(worktree), true))
      startTabsPushLoop(ws, worktree, () => {
        const changed = tabsResultIfChanged(worktree)
        if (changed) {
          respond(success(request.id, changed, true))
        }
      })
      return true
    }

    case 'session.tabs.unsubscribe':
      stopTabsPushLoop(ws, worktreeOf(request))
      respond(success(request.id, { ok: true }))
      return true

    case 'session.tabs.activate':
    case 'nativeChat.unsubscribe':
      respond(success(request.id, { ok: true }))
      return true

    case 'terminal.list': {
      // `omit` = empty list; `other` = a live list that just doesn't name the
      // chat handle (what the runtime returns when the handle is scoped to a
      // different worktree id than the one mobile queries).
      const mode = readControl(TERMINAL_LIST_MODE_FILE)
      const worktreeId = worktreeOf(request).replace(/^id:/, '')
      const entry = (handle: string) => ({
        handle,
        worktreeId,
        title: 'Claude Code',
        isActive: true,
        hasRunningProcess: true
      })
      const terminals =
        mode === 'omit'
          ? []
          : mode === 'other'
            ? [entry('some-other-term')]
            : [entry(TERMINAL_HANDLE)]
      respond(success(request.id, { terminals, totalCount: terminals.length, truncated: false }))
      return true
    }

    case 'nativeChat.subscribe':
      respond(success(request.id, { type: 'snapshot', messages: [], hasMore: false }, true))
      return true

    case 'nativeChat.readSession':
      respond(success(request.id, { messages: [], hasMore: false }))
      return true

    case 'terminal.subscribe': {
      // The `subscribed` frame is what releases mobile's native-chat input lease.
      respond(success(request.id, { type: 'subscribed', terminal: TERMINAL_HANDLE }, true))
      if (readControl(TERMINAL_STREAM_MODE_FILE) === 'dead') {
        respond(success(request.id, { type: 'end' }))
        return true
      }
      respond(
        success(
          request.id,
          { type: 'scrollback', serialized: '', cols: 80, rows: 24, seq: 1 },
          true
        )
      )
      return true
    }

    case 'terminal.send': {
      const mode = readControl(SEND_MODE_FILE) || 'accept'
      console.log(`[mock] terminal.send mode=${mode} text=${JSON.stringify(request.params?.text)}`)
      if (mode === 'error') {
        respond(error(request.id, 'mobile_input_floor_unavailable', 'Mobile input floor is held'))
        return true
      }
      respond(
        success(request.id, {
          send: {
            handle: TERMINAL_HANDLE,
            accepted: mode === 'accept',
            bytesWritten: mode === 'accept' ? String(request.params?.text ?? '').length : 0
          }
        })
      )
      return true
    }

    case 'clipboard.startImageUpload':
      respond(success(request.id, { uploadId: 'mock-upload-1' }))
      return true

    case 'clipboard.appendImageUploadChunk':
      respond(success(request.id, { ok: true }))
      return true

    case 'clipboard.commitImageUpload':
    case 'clipboard.saveImageAsTempFile':
      respond(success(request.id, MOCK_IMAGE_PATH))
      return true

    case 'clipboard.abortImageUpload':
      respond(success(request.id, { ok: true }))
      return true

    default:
      return false
  }
}
