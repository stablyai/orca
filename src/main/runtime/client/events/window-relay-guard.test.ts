// The census of every relay from main to the owner's window: each method's kind and every target it
// names. A wrong row either leaks a teammate's workspace to the window or drops the owner's own relay.
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_CHANNEL_TABLE,
  guardDesktopSurface,
  guardWindowRelays,
  WINDOW_RELAY_TABLE,
  type WindowRelayLists
} from './window-relay-guard'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

const K = 'person:home-1:bot-1:usr_mate'
const LEAF = '0f8fad5b-d9cb-469f-a165-70867728950e'
// A chat's tab id and a file's path are the same in every list of a workspace, so the guard never
// reads a tab: these are the same for the owner and the teammate.
const TAB = 'agent-session:chat-k'
const PANE = `${TAB}:${LEAF}`
type Field = 'worktree' | 'pty' | 'page'
type Names = Record<Field, string>
const owner: Names = { worktree: 'folder:home-1', pty: 'owner-pty', page: 'owner-page' }
const teammate: Names = { worktree: K, pty: 'mate-pty', page: 'mate-page' }
const lists: WindowRelayLists = {
  heldPty: (ptyId) => ptyId === teammate.pty,
  heldPage: (pageId) => pageId === teammate.page
}

type Census = { fields: Field[]; args: (n: Names) => unknown[] }
const HOST = [
  'automationsChanged',
  'worktreesChanged',
  'workspaceMetadataSet',
  'worktreeBaseStatus',
  'worktreeRemoteBranchConflict',
  'reposChanged',
  'browserProfilesChanged',
  'botsChanged',
  'orchestrationSessionWorkersChanged',
  'peerMailReturned',
  'mcpServersChanged',
  'workspaceCleanupRunFinished',
  'restartOffersChanged',
  'sleepingMailChanged',
  'claudeAccountSelected',
  'applyAgentPaneActivity'
]
const NOTICES: Record<string, Census> = {
  agentLaunchPaneVerdict: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, tabId: TAB, leafId: LEAF, verdict: 'started' }]
  },
  rememberLaunchRecipe: {
    fields: ['worktree'],
    args: (n) => [{ tabId: TAB, leafId: LEAF }, n.worktree]
  },
  resolveLegacyWorkerTerminalRecovery: { fields: ['pty'], args: (n) => [PANE, 'adopted', n.pty] },
  workspaceSleepChanged: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, phase: 'started' }]
  },
  terminalFitOverrideChanged: { fields: ['pty'], args: (n) => [n.pty, 'mobile-fit', 80, 24] },
  terminalDriverChanged: { fields: ['pty'], args: (n) => [n.pty, { kind: 'idle' }] },
  nativeChatLaunchDraftResolved: {
    fields: ['worktree'],
    args: (n) => [TAB, { text: 'hi', createdAt: 1 }, n.worktree]
  },
  browserDriverChanged: { fields: ['page'], args: (n) => [n.page, { kind: 'idle' }] },
  browserRemoteViewersChanged: { fields: ['page'], args: (n) => [n.page, true] },
  clientHostedBrowserRowsChanged: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, rows: [] }]
  }
}
const ACTS: Record<string, Census> = {
  activateWorktree: { fields: ['worktree'], args: (n) => ['repo-1', n.worktree] },
  createTerminal: { fields: ['worktree'], args: (n) => [n.worktree, {}] },
  revealTerminalSession: {
    fields: ['worktree', 'pty'],
    args: (n) => [n.worktree, { ptyId: n.pty, tabId: TAB }]
  },
  publishAgentLaunchTab: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, tabId: TAB, leafId: LEAF }]
  },
  splitTerminal: {
    fields: ['worktree'],
    args: (n) => [TAB, 1, { direction: 'vertical', worktreeId: n.worktree }]
  },
  renameTerminal: { fields: ['worktree'], args: (n) => [TAB, 'Build', n.worktree] },
  setPaneTitle: { fields: ['worktree'], args: (n) => [TAB, LEAF, 'Build', n.worktree] },
  focusTerminal: { fields: ['worktree'], args: (n) => [TAB, n.worktree, LEAF] },
  revealTerminalPane: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, tabId: TAB, leafId: LEAF, executionHostId: null }]
  },
  focusEditorTab: { fields: ['worktree'], args: (n) => [TAB, n.worktree] },
  closeSessionTab: { fields: ['worktree'], args: (n) => [TAB, n.worktree] },
  moveSessionTab: {
    fields: ['worktree'],
    args: (n) => [n.worktree, { kind: 'move-to-group', tabId: TAB, targetGroupId: 'g' }]
  },
  movePaneToNewTab: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, sourceTabId: TAB, targetTabId: 't', leafId: LEAF }]
  },
  openFile: { fields: ['worktree'], args: (n) => [n.worktree, '/a', 'a'] },
  revealEditorTab: {
    fields: ['worktree'],
    args: (n) => [{ worktreeId: n.worktree, tabId: '/a', filePath: '/a', relativePath: 'a' }]
  },
  openDiff: { fields: ['worktree'], args: (n) => [n.worktree, '/a', 'a', false] },
  closeTerminal: { fields: ['worktree'], args: (n) => [TAB, n.worktree] },
  closeTerminalPane: { fields: ['worktree'], args: (n) => [TAB, LEAF, n.worktree] },
  closeTerminalTab: { fields: ['worktree'], args: (n) => [TAB, n.worktree] },
  resumeSleepingAgents: { fields: ['worktree'], args: (n) => [n.worktree, PANE] }
}
const ASYNC = [
  'revealTerminalSession',
  'publishAgentLaunchTab',
  'revealTerminalPane',
  'closeSessionTab',
  'movePaneToNewTab',
  'closeTerminalTab',
  'resumeSleepingAgents'
]

/** Names `n`, with only `field` the teammate's. */
const only = (field: Field): Names => ({ ...owner, [field]: teammate[field] })

function recorder() {
  const calls: { name: string; args: unknown[] }[] = []
  const answer = { answered: true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: it answers every notifier method the table lists.
  const notifier = Object.fromEntries(
    Object.keys(WINDOW_RELAY_TABLE).map((name) => [
      name,
      (...args: unknown[]) => (calls.push({ name, args }), answer)
    ])
  ) as unknown as RuntimeNotifier
  return { calls, answer, notifier }
}

const call = (notifier: RuntimeNotifier, name: string, args: unknown[]): unknown =>
  Reflect.apply(Reflect.get(notifier, name), notifier, args)

describe('the window relay table', () => {
  it('has a row for exactly the census, each of its kind', () => {
    const kinds = Object.fromEntries(
      Object.entries(WINDOW_RELAY_TABLE).map(([name, row]) => [
        name,
        row === 'host' ? 'host' : `${row.kind}${row.async ? ':async' : ''}`
      ])
    )
    expect(kinds).toEqual({
      ...Object.fromEntries(HOST.map((name) => [name, 'host'])),
      ...Object.fromEntries(Object.keys(NOTICES).map((name) => [name, 'notice'])),
      ...Object.fromEntries(
        Object.keys(ACTS).map((name) => [name, ASYNC.includes(name) ? 'act:async' : 'act'])
      )
    })
  })

  it("forwards every relay naming only the owner's window, its arguments and answer untouched", () => {
    for (const [name, census] of Object.entries({ ...NOTICES, ...ACTS })) {
      const { calls, answer, notifier } = recorder()
      const args = census.args(owner)
      expect(call(guardWindowRelays(notifier, lists), name, args), name).toBe(answer)
      expect(calls, name).toEqual([{ name, args }])
      expect(
        calls[0]!.args.every((arg, index) => arg === args[index]),
        name
      ).toBe(true)
    }
  })

  it("refuses an act and drops a notice naming a teammate's workspace by any of its targets", async () => {
    for (const [name, census] of Object.entries({ ...NOTICES, ...ACTS })) {
      for (const field of census.fields) {
        const { calls, notifier } = recorder()
        const guarded = guardWindowRelays(notifier, lists)
        const args = census.args(only(field))
        if (name in NOTICES) {
          expect(call(guarded, name, args), `${name} by ${field}`).toBeUndefined()
        } else {
          expect(() => call(guarded, name, args), `${name} by ${field}`).toThrow(
            new RegExp(`window_relay_refused: ${name} `)
          )
        }
        expect(calls, `${name} by ${field}`).toEqual([])
      }
    }
  })

  it('passes host-wide events through as the notifier’s own, whatever they carry', () => {
    const { calls, answer, notifier } = recorder()
    const guarded = guardWindowRelays(notifier, lists)
    for (const name of HOST) {
      expect(call(guarded, name, [K, TAB]), name).toBe(answer)
    }
    expect(calls.map((entry) => entry.name)).toEqual(HOST)
  })

  it('refuses a method with no row, and keeps a method the window lacks absent', () => {
    const { notifier } = recorder()
    const unlisted = Object.assign(notifier, { revealSomethingNew: () => 'sent' })
    const guarded = guardWindowRelays(unlisted, lists)
    expect(() => call(guarded, 'revealSomethingNew', [])).toThrow(
      /window_relay_refused: revealSomethingNew names an unlisted relay/
    )
    const none = () => {}
    const partial = guardWindowRelays(
      {
        worktreesChanged: none,
        reposChanged: none,
        activateWorktree: none,
        createTerminal: none,
        splitTerminal: none,
        renameTerminal: none,
        focusTerminal: none,
        closeTerminal: none,
        terminalFitOverrideChanged: none,
        terminalDriverChanged: none
      },
      lists
    )
    expect(partial.setPaneTitle).toBeUndefined()
    expect(Reflect.get(partial, 'then')).toBeUndefined()
  })

  it('drops a refused relay in production and answers an awaited one as an unreachable window', async () => {
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const { calls, notifier } = recorder()
      const guarded = guardWindowRelays(notifier, lists)
      expect(call(guarded, 'createTerminal', [K, {}])).toBeUndefined()
      await expect(call(guarded, 'closeTerminalTab', [TAB, K])).rejects.toThrow(
        'runtime_unavailable'
      )
      expect(calls).toEqual([])
    } finally {
      process.env.NODE_ENV = env
    }
  })
})

describe('the desktop channel table', () => {
  const PAYLOAD_FIELD: Record<string, Field> = {
    worktreeId: 'worktree',
    fallbackWorktreeId: 'worktree',
    ptyId: 'pty',
    browserPageId: 'page'
  }
  const CHANNELS: Record<string, { kind: 'notice' | 'act'; fields: string[] }> = {
    'terminal:requestTabMount': { kind: 'act', fields: ['worktreeId', 'ptyId'] },
    'terminal:requestTabCreate': { kind: 'act', fields: ['worktreeId'] },
    'browser:requestTabCreate': {
      kind: 'act',
      fields: ['worktreeId', 'fallbackWorktreeId', 'browserPageId']
    },
    'browser:requestTabClose': { kind: 'act', fields: ['worktreeId'] },
    'browser:requestTabActivate': { kind: 'act', fields: ['browserPageId'] },
    'browser:requestTabSetProfile': { kind: 'act', fields: ['browserPageId'] },
    'browser:activateView': { kind: 'act', fields: ['worktreeId', 'browserPageId'] },
    'browser:navigation-update': { kind: 'notice', fields: ['browserPageId'] },
    'browser:pane-focus': { kind: 'notice', fields: ['worktreeId', 'browserPageId'] },
    'emulator:pane-focus': { kind: 'notice', fields: ['worktreeId'] },
    'ui:emulatorAutoAttach': { kind: 'act', fields: ['worktreeId'] },
    // Classified at their one source (owner-window-agent-status.ts), pushed and pulled alike.
    'agentStatus:set': { kind: 'notice', fields: [] },
    'agentStatus:clear': { kind: 'notice', fields: [] },
    'agentStatus:migrationUnsupported': { kind: 'notice', fields: [] },
    'agentStatus:migrationUnsupportedClear': { kind: 'notice', fields: [] }
  }
  const payload = (fields: string[], names: Names) =>
    Object.fromEntries(fields.map((field) => [field, names[PAYLOAD_FIELD[field]!]]))

  function desktop() {
    const sent: { channel: string; payload: unknown }[] = []
    const raw: RuntimeDesktopSurface = {
      showNotification: () => true,
      hasWindow: () => true,
      hasLiveRenderer: () => true,
      sendToWindow: (_windowId, channel, payload) => (sent.push({ channel, payload }), true),
      requestRenderer: <T>(_windowId: number, request: { channel: string; payload: object }) => (
        sent.push({ channel: request.channel, payload: request.payload }),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no caller here reads past the request id.
        Promise.resolve({ requestId: 'r' } as T)
      )
    }
    return { sent, surface: guardDesktopSurface(raw, lists) }
  }

  it('lists exactly the census of channels', () => {
    expect(DESKTOP_CHANNEL_TABLE).toEqual(CHANNELS)
  })

  it("forwards a send or request naming only the owner's window, and refuses one naming a teammate's", async () => {
    for (const [channel, row] of Object.entries(CHANNELS)) {
      const { sent, surface } = desktop()
      const forwarded = payload(row.fields, owner)
      expect(surface.sendToWindow(1, channel, forwarded), channel).toBe(true)
      await surface.requestRenderer(1, {
        channel,
        replyChannel: 'reply',
        payload: forwarded,
        timeoutMs: 1,
        timeoutMessage: 't'
      })
      expect(sent, channel).toEqual([
        { channel, payload: forwarded },
        { channel, payload: forwarded }
      ])
      for (const field of row.fields) {
        const named = { ...forwarded, [field]: teammate[PAYLOAD_FIELD[field]!] }
        const { sent: refused, surface: guarded } = desktop()
        if (row.kind === 'notice') {
          expect(guarded.sendToWindow(1, channel, named), `${channel} by ${field}`).toBe(false)
        } else {
          expect(() => guarded.sendToWindow(1, channel, named), `${channel} by ${field}`).toThrow(
            /window_relay_refused/
          )
        }
        expect(refused, `${channel} by ${field}`).toEqual([])
      }
    }
  })

  it('refuses a channel with no row', () => {
    const { sent, surface } = desktop()
    expect(() => surface.sendToWindow(1, 'terminal:somethingNew', {})).toThrow(
      /window_relay_refused: terminal:somethingNew names an unlisted channel/
    )
    expect(sent).toEqual([])
  })
})
