// The one door from main to the owner's window: nothing aimed at a teammate's own workspace in a
// shared agent's Home reaches it. Every notifier method and desktop channel has a row here, and one
// without a row is refused, so a new relay cannot reach the window unread.
import { isPersonWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type {
  RendererReply,
  RendererRequest,
  RuntimeDesktopSurface
} from '../../construction/runtime-desktop-surface'
import type { RuntimeNotifier } from './runtime-notifier-contract'

/** What a relay names. A held PTY, page or tab is in a teammate's own workspace. */
export type WindowRelayTarget = {
  worktreeId?: string | null
  tabId?: string | null
  ptyId?: string | null
  browserPageId?: string | null
  paneKeys?: readonly string[]
}

/** How the host tells that a handle is in a teammate's own workspace. */
export type WindowRelayLists = {
  heldPty(ptyId: string): boolean
  heldPage(browserPageId: string): boolean
  heldTab(tabId: string): boolean
}

type NotifierMethod = keyof RuntimeNotifier
type RelayArgs<M extends NotifierMethod> = Parameters<NonNullable<RuntimeNotifier[M]>>

/** `host`: a host-wide event with no workspace, forwarded untouched. `notice`: a fact the window
 *  mirrors; dropped for a teammate's target, as no window shows it. `act`: the window changes its
 *  tabs; for a teammate's target a branching site missed `windowOwns`, so it is refused. */
export type WindowRelayRow<M extends NotifierMethod> =
  | 'host'
  | {
      kind: 'notice' | 'act'
      /** The caller awaits it: a refusal rejects, as an unreachable window does. */
      async?: true
      targets: (...args: RelayArgs<M>) => WindowRelayTarget
    }

const notice = <M extends NotifierMethod>(
  targets: (...args: RelayArgs<M>) => WindowRelayTarget
): WindowRelayRow<M> => ({ kind: 'notice', targets })
const act = <M extends NotifierMethod>(
  targets: (...args: RelayArgs<M>) => WindowRelayTarget,
  async?: true
): WindowRelayRow<M> => ({ kind: 'act', targets, ...(async ? { async } : {}) })

export const WINDOW_RELAY_TABLE: { [M in NotifierMethod]-?: WindowRelayRow<M> } = {
  automationsChanged: 'host',
  worktreesChanged: 'host',
  workspaceMetadataSet: 'host',
  worktreeBaseStatus: 'host',
  worktreeRemoteBranchConflict: 'host',
  reposChanged: 'host',
  browserProfilesChanged: 'host',
  botsChanged: 'host',
  orchestrationSessionWorkersChanged: 'host',
  peerMailReturned: 'host',
  mcpServersChanged: 'host',
  workspaceCleanupRunFinished: 'host',
  restartOffersChanged: 'host',
  sleepingMailChanged: 'host',
  claudeAccountSelected: 'host',
  activateWorktree: act((_repoId, worktreeId) => ({ worktreeId })),
  createTerminal: act((worktreeId) => ({ worktreeId })),
  revealTerminalSession: act(
    (worktreeId, opts) => ({ worktreeId, ptyId: opts.ptyId, tabId: opts.tabId }),
    true
  ),
  publishAgentLaunchTab: act(
    (request) => ({ worktreeId: request.worktreeId, tabId: request.tabId }),
    true
  ),
  agentLaunchPaneVerdict: notice((event) => ({ worktreeId: event.worktreeId, tabId: event.tabId })),
  rememberLaunchRecipe: notice((recipe) => ({ tabId: recipe.tabId })),
  resolveLegacyWorkerTerminalRecovery: notice((paneKey, _resolution, ptyId) => ({
    paneKeys: [paneKey],
    ptyId
  })),
  splitTerminal: act((tabId, _paneRuntimeId, opts) => ({ tabId, worktreeId: opts.worktreeId })),
  renameTerminal: act((tabId) => ({ tabId })),
  setPaneTitle: act((tabId) => ({ tabId })),
  focusTerminal: act((tabId, worktreeId) => ({ tabId, worktreeId })),
  revealTerminalPane: act(
    (target) => ({ worktreeId: target.worktreeId, tabId: target.tabId }),
    true
  ),
  focusEditorTab: act((tabId, worktreeId) => ({ tabId, worktreeId })),
  closeSessionTab: act((tabId, worktreeId) => ({ tabId, worktreeId }), true),
  moveSessionTab: act((worktreeId, move) => ({ worktreeId, tabId: move.tabId })),
  movePaneToNewTab: act((move) => ({ worktreeId: move.worktreeId, tabId: move.sourceTabId }), true),
  openFile: act((worktreeId) => ({ worktreeId })),
  revealEditorTab: act((reveal) => ({ worktreeId: reveal.worktreeId, tabId: reveal.tabId })),
  openDiff: act((worktreeId) => ({ worktreeId })),
  closeTerminal: act((tabId) => ({ tabId })),
  closeTerminalPane: act((tabId) => ({ tabId })),
  closeTerminalTab: act((tabId) => ({ tabId }), true),
  workspaceSleepChanged: notice((sleep) => ({ worktreeId: sleep.worktreeId })),
  resumeSleepingAgents: act(
    (worktreeId, paneKey) => ({ worktreeId, paneKeys: paneKey ? [paneKey] : [] }),
    true
  ),
  applyAgentPaneActivity: act((change) => ({ paneKeys: change.paneKeys }), true),
  terminalFitOverrideChanged: notice((ptyId) => ({ ptyId })),
  terminalDriverChanged: notice((ptyId) => ({ ptyId })),
  nativeChatLaunchDraftResolved: notice((tabId) => ({ tabId })),
  browserDriverChanged: notice((browserPageId) => ({ browserPageId })),
  browserRemoteViewersChanged: notice((browserPageId) => ({ browserPageId })),
  clientHostedBrowserRowsChanged: notice((event) => ({ worktreeId: event.worktreeId }))
}

type PayloadField =
  | 'worktreeId'
  | 'fallbackWorktreeId'
  | 'tabId'
  | 'splitFromTabId'
  | 'ptyId'
  | 'paneKey'
type DesktopChannelRow = {
  kind: 'notice' | 'act'
  fields: readonly (PayloadField | 'browserPageId')[]
}

/** Every channel main sends or requests of the window through the desktop surface. */
export const DESKTOP_CHANNEL_TABLE: Readonly<Record<string, DesktopChannelRow>> = {
  'terminal:requestTabMount': { kind: 'act', fields: ['worktreeId', 'tabId', 'ptyId'] },
  'terminal:requestTabCreate': { kind: 'act', fields: ['worktreeId'] },
  'browser:requestTabCreate': {
    kind: 'act',
    fields: ['worktreeId', 'fallbackWorktreeId', 'browserPageId', 'splitFromTabId']
  },
  'browser:requestTabClose': { kind: 'act', fields: ['worktreeId', 'tabId'] },
  'browser:requestTabActivate': { kind: 'act', fields: ['browserPageId'] },
  'browser:requestTabSetProfile': { kind: 'act', fields: ['browserPageId'] },
  'browser:activateView': { kind: 'act', fields: ['worktreeId', 'browserPageId'] },
  'browser:navigation-update': { kind: 'notice', fields: ['browserPageId'] },
  'browser:pane-focus': { kind: 'notice', fields: ['worktreeId', 'browserPageId'] },
  'emulator:pane-focus': { kind: 'notice', fields: ['worktreeId'] },
  'ui:emulatorAutoAttach': { kind: 'act', fields: ['worktreeId'] },
  'agentStatus:set': { kind: 'notice', fields: ['worktreeId', 'tabId', 'paneKey'] },
  'agentStatus:clear': { kind: 'notice', fields: ['paneKey'] },
  'agentStatus:migrationUnsupported': { kind: 'notice', fields: ['worktreeId', 'tabId', 'ptyId'] },
  'agentStatus:migrationUnsupportedClear': { kind: 'notice', fields: ['ptyId'] }
}

/** The teammate's workspace a relay names, or null when every target is the window's. */
function personTargetOf(target: WindowRelayTarget, lists: WindowRelayLists): string | null {
  if (target.worktreeId && isPersonWorkspaceKey(target.worktreeId)) {
    return target.worktreeId
  }
  if (target.ptyId && lists.heldPty(target.ptyId)) {
    return `pty ${target.ptyId}`
  }
  if (target.browserPageId && lists.heldPage(target.browserPageId)) {
    return `page ${target.browserPageId}`
  }
  const tabIds = [
    target.tabId,
    ...(target.paneKeys ?? []).map((paneKey) => parsePaneKey(paneKey)?.tabId)
  ]
  const tabId = tabIds.find((id) => id && lists.heldTab(id))
  return tabId ? `tab ${tabId}` : null
}

const warnedRefusals = new Set<string>()

/** A relay a branching site should have kept headless: loud in dev and tests, dropped and
 *  logged once per method in production so the owner's window never acts on it. */
function refuseRelay(method: string, target: string): void {
  const message = `window_relay_refused: ${method} names ${target}, which no window shows`
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    throw new Error(message)
  }
  if (!warnedRefusals.has(method)) {
    warnedRefusals.add(method)
    console.warn(`[window-relay] ${message}`)
  }
}

type RelayRow =
  | 'host'
  | { kind: 'notice' | 'act'; async?: true; targets: (...args: unknown[]) => WindowRelayTarget }

const RELAY_ROWS: ReadonlyMap<string, RelayRow> = new Map(
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each row reads the arguments of the method it is keyed by, which is the only call it gets.
  Object.entries(WINDOW_RELAY_TABLE) as [string, RelayRow][]
)

/** The owner's window as main sees it: each method of `raw` behind its row. Host-wide events are
 *  `raw`'s own functions, and a forwarded relay passes its arguments and answer through untouched. */
export function guardWindowRelays(raw: RuntimeNotifier, lists: WindowRelayLists): RuntimeNotifier {
  const wrapped = new Map<string, { method: unknown; relay: unknown }>()
  const wrap = (name: string, forward: (args: unknown[]) => unknown): unknown => {
    const row = RELAY_ROWS.get(name)
    return (...args: unknown[]) => {
      if (row === undefined || row === 'host') {
        // A method no row reads is refused whatever it names.
        refuseRelay(name, 'an unlisted relay')
        return undefined
      }
      const target = personTargetOf(row.targets(...args), lists)
      if (target === null) {
        return forward(args)
      }
      if (row.kind === 'notice') {
        return undefined
      }
      refuseRelay(name, target)
      return row.async ? Promise.reject(new Error('runtime_unavailable')) : undefined
    }
  }
  // A proxy, so a method `raw` lacks stays absent for the callers that test for it.
  return new Proxy(raw, {
    get(target, name, receiver) {
      const method: unknown = Reflect.get(target, name, receiver)
      if (typeof name !== 'string' || typeof method !== 'function' || name in Object.prototype) {
        return method
      }
      if (RELAY_ROWS.get(name) === 'host') {
        return method.bind(raw)
      }
      let entry = wrapped.get(name)
      if (entry?.method !== method) {
        entry = { method, relay: wrap(name, (args) => Reflect.apply(method, raw, args)) }
        wrapped.set(name, entry)
      }
      return entry.relay
    }
  })
}

const PAYLOAD_TARGET: Record<PayloadField | 'browserPageId', (value: string) => WindowRelayTarget> =
  {
    worktreeId: (worktreeId) => ({ worktreeId }),
    fallbackWorktreeId: (worktreeId) => ({ worktreeId }),
    tabId: (tabId) => ({ tabId }),
    splitFromTabId: (tabId) => ({ tabId }),
    ptyId: (ptyId) => ({ ptyId }),
    paneKey: (paneKey) => ({ paneKeys: [paneKey] }),
    browserPageId: (browserPageId) => ({ browserPageId })
  }

/** Each field a channel's payload names, as its own target, so none hides behind another. */
function payloadTargets(row: DesktopChannelRow, payload: unknown): WindowRelayTarget[] {
  const fields = new Map<string, unknown>(
    typeof payload === 'object' && payload !== null ? Object.entries(payload) : []
  )
  return row.fields.flatMap((field) => {
    const value = fields.get(field)
    return typeof value === 'string' ? [PAYLOAD_TARGET[field](value)] : []
  })
}

/** The desktop surface's sends and requests to the window behind the same rule, by channel. */
export function guardDesktopSurface(
  raw: RuntimeDesktopSurface,
  lists: WindowRelayLists
): RuntimeDesktopSurface {
  const refusedTarget = (channel: string, payload: unknown): string | null => {
    const row = DESKTOP_CHANNEL_TABLE[channel]
    const target = row
      ? (payloadTargets(row, payload)
          .map((named) => personTargetOf(named, lists))
          .find((person) => person !== null) ?? null)
      : 'an unlisted channel'
    if (target !== null && row?.kind !== 'notice') {
      refuseRelay(channel, target)
    }
    return target
  }
  return {
    ...raw,
    sendToWindow: (windowId, channel, payload) =>
      refusedTarget(channel, payload) === null && raw.sendToWindow(windowId, channel, payload),
    requestRenderer: <T extends RendererReply>(windowId: number, request: RendererRequest) =>
      refusedTarget(request.channel, request.payload) === null
        ? raw.requestRenderer<T>(windowId, request)
        : Promise.reject(new Error('runtime_unavailable'))
  }
}
