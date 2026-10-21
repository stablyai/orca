import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { LAYOUT_APPLY_METHODS } from './workspace-layout'

const frozen = vi.hoisted(() => ({ workspaces: new Set<string>() }))
vi.mock(
  '../../../persistence/moving-wsl-projects/wsl-move-scope-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isWslMoveWorkspaceSessionFrozen: (workspace: string) => frozen.workspaces.has(workspace)
  })
)

const WORKTREE = 'repo-1::/work/one'
const SPLIT = {
  type: 'splitPane',
  workspace: WORKTREE,
  tabId: 'tab-1',
  leafId: 'leaf-1',
  direction: 'vertical'
} as const

async function registeredMethods(layoutOwnerIsMain: boolean) {
  vi.resetModules()
  vi.doMock('../../../../shared/layout-owner-switch', () => ({
    ORCA_LAYOUT_OWNER_IS_MAIN: layoutOwnerIsMain
  }))
  const { ALL_RPC_METHODS } = await import('./index')
  return eraseRpcMethods(ALL_RPC_METHODS)
}

function sessionListing(tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE,
    activeTabId: tabId,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

function runtimeHolding(hostId: string) {
  const applyLayoutCommand = vi.fn(async () => ({ ok: true, result: { leafId: 'minted' } }))
  const applyTabRenames = vi.fn(async () => [])
  const empty: WorkspaceSessionState = { ...sessionListing('other'), tabsByWorktree: {} }
  const store = {
    getRepo: () => undefined,
    getWorkspaceSessionHostIds: () => ['local', hostId],
    getWorkspaceSession: (host: string) => (host === hostId ? sessionListing('tab-1') : empty),
    applyLayoutCommand,
    applyTabRenames
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply path reads only these store methods.
  return { runtime: new OrcaRuntimeService(store as never), applyLayoutCommand, applyTabRenames }
}

afterEach(() => {
  frozen.workspaces.clear()
  vi.doUnmock('../../../../shared/layout-owner-switch')
  vi.resetModules()
})

describe('layout.apply', () => {
  it('is not registered in a window-owned build, and never advertised or open to phones', async () => {
    const methods = await registeredMethods(false)

    expect(methods.some((method) => method.name === 'layout.apply')).toBe(false)
    expect(RUNTIME_CAPABILITIES.some((capability) => capability.startsWith('layout'))).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('layout.apply')).toBe(false)
  })

  it('is registered in a layout-owner build; a split keeps only a valid window pane id', async () => {
    const apply = (await registeredMethods(true)).find((method) => method.name === 'layout.apply')
    if (!apply || isStreamingMethod(apply)) {
      throw new Error('layout.apply is not a request method')
    }
    const applyLayoutCommand = vi.fn(async () => ({ ok: true, result: {} }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only applyLayoutCommand.
    const runtime = { applyLayoutCommand } as unknown as OrcaRuntimeService
    const newLeafId = '33333333-3333-4333-8333-333333333333'

    const params = apply.params?.parse({ command: { ...SPLIT, newLeafId, groupId: 'window-g' } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime from its context.
    await apply.handler(params, { runtime } as RpcContext)

    expect(applyLayoutCommand).toHaveBeenCalledWith({ ...SPLIT, newLeafId })
    expect(apply.params?.parse({ command: { ...SPLIT, id: 'window-id' } })).toEqual({
      command: SPLIT
    })
    expect(
      apply.params?.safeParse({ command: { ...SPLIT, newLeafId: 'window-minted' } }).success
    ).toBe(false)
  })

  it('takes no live-terminal adoption from the window: only main places a running terminal', () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const create = {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: 'tab-2',
      leafId: '44444444-4444-4444-8444-444444444444'
    } as const

    expect(apply?.params?.parse({ command: { ...create, adopt: { ptyId: 'pty-1' } } })).toEqual({
      command: create
    })
  })

  it('takes no close semantics or blank title from the window', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const pane = { workspace: WORKTREE, tabId: 'tab-1', leafId: 'leaf-1' }

    expect(
      apply?.params?.parse({
        command: { type: 'closePane', ...pane, userPaneClose: true }
      })
    ).toEqual({ command: { type: 'closePane', ...pane } })
    expect(
      apply?.params?.safeParse({ command: { type: 'renamePane', ...pane, title: '  ' } }).success
    ).toBe(false)
    expect(
      apply?.params?.parse({ command: { type: 'renamePane', ...pane, title: ' Build ' } })
    ).toEqual({ command: { type: 'renamePane', ...pane, title: 'Build' } })
  })

  it('accepts only a drop side and a valid pane tree for gestures', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const pane = { workspace: WORKTREE, tabId: 'tab-1', leafId: 'leaf-1' }
    const move = { type: 'movePane', ...pane, targetLeafId: 'leaf-2' }
    const ratios = { type: 'setPaneRatios', workspace: WORKTREE, tabId: 'tab-1' }

    expect(apply?.params?.safeParse({ command: { ...move, side: 'left' } }).success).toBe(true)
    expect(apply?.params?.safeParse({ command: { ...move, side: 'center' } }).success).toBe(false)
    expect(
      apply?.params?.safeParse({
        command: { ...ratios, root: { type: 'split', direction: 'vertical', ratio: 2 } }
      }).success
    ).toBe(false)
  })

  it('accepts tab moves and group sizes, but no group id from the window', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const tab = { workspace: WORKTREE, tabId: 'tab-1' }
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })

    expect(parse({ type: 'moveTab', ...tab, toGroupId: 'g1', index: 0 })?.success).toBe(true)
    expect(parse({ type: 'moveTab', ...tab, toGroupId: 'g1', index: -1 })?.success).toBe(false)
    expect(
      apply?.params?.parse({
        command: {
          type: 'splitGroup',
          ...tab,
          besideGroupId: 'g1',
          direction: 'left',
          newGroupId: 'window-minted'
        }
      })
    ).toEqual({
      command: { type: 'splitGroup', ...tab, besideGroupId: 'g1', direction: 'left' }
    })
    expect(
      parse({ type: 'splitGroup', ...tab, besideGroupId: 'g1', direction: 'center' })?.success
    ).toBe(false)
    const split = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g2' }
    }
    expect(
      parse({ type: 'setGroupRatios', workspace: WORKTREE, groupLayout: { ...split, ratio: 0.3 } })
        ?.success
    ).toBe(true)
    expect(
      parse({ type: 'setGroupRatios', workspace: WORKTREE, groupLayout: { ...split, ratio: 3 } })
        ?.success
    ).toBe(false)
  })

  it('accepts divider ratio intents, or an older window’s tree, but not both or neither', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const pane = { type: 'setPaneRatios', workspace: WORKTREE, tabId: 'tab-1' }
    const group = { type: 'setGroupRatios', workspace: WORKTREE }
    const root = { type: 'leaf', leafId: 'leaf-1' }
    const groupLayout = { type: 'leaf', groupId: 'g1' }
    const ratios = [{ path: 'first.second', ratio: 0.3 }]

    expect(parse({ ...pane, ratios })?.success).toBe(true)
    expect(parse({ ...pane, root })?.success).toBe(true)
    expect(parse({ ...pane, root, ratios })?.success).toBe(false)
    expect(parse(pane)?.success).toBe(false)
    expect(parse({ ...group, ratios })?.success).toBe(true)
    expect(parse({ ...group, groupLayout })?.success).toBe(true)
    expect(parse({ ...group, groupLayout, ratios })?.success).toBe(false)
    expect(parse(group)?.success).toBe(false)
    expect(parse({ ...pane, ratios: [] })?.success).toBe(false)
    expect(parse({ ...pane, ratios: [{ path: 'third', ratio: 0.3 }] })?.success).toBe(false)
    expect(parse({ ...pane, ratios: [{ path: '', ratio: 1 }] })?.success).toBe(false)
  })

  it('accepts the close of one tab with the window’s reason, but no force or refusals', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const close = { type: 'closeTabs', workspace: WORKTREE, recordClose: 'user' }

    expect(
      apply?.params?.parse({
        command: { ...close, tabIds: ['tab-1'], force: false, refusePinned: true }
      })
    ).toEqual({ command: { ...close, tabIds: ['tab-1'] } })
    expect(apply?.params?.safeParse({ command: { ...close, tabIds: ['a', 'b'] } }).success).toBe(
      false
    )
    expect(
      apply?.params?.safeParse({ command: { ...close, tabIds: ['a'], recordClose: 'pty-exit' } })
        .success
    ).toBe(false)
  })

  it('accepts a drag-out with the window’s terminal, but no tab id from the window', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const move = {
      type: 'movePaneToNewTab',
      workspace: WORKTREE,
      tabId: 'tab-1',
      leafId: 'leaf-1',
      groupId: 'g1',
      index: 2
    }

    expect(
      apply?.params?.parse({ command: { ...move, windowDetach: { ptyId: 'pty-1', tabId: 'x' } } })
    ).toEqual({ command: { ...move, windowDetach: { ptyId: 'pty-1' } } })
    expect(
      apply?.params?.parse({
        command: { ...move, windowDetach: { ptyId: null, startupCwd: '/a' } }
      })
    ).toEqual({ command: { ...move, windowDetach: { ptyId: null, startupCwd: '/a' } } })
    expect(apply?.params?.safeParse({ command: { ...move, windowDetach: {} } }).success).toBe(false)
    expect(
      apply?.params?.safeParse({ command: { ...move, windowDetach: { ptyId: null }, index: -1 } })
        .success
    ).toBe(false)
  })

  it('takes a browser tab under the window’s ids, and its page and profile changes', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const open = {
      type: 'openBrowserTab',
      workspace: WORKTREE,
      tabId: 'entry-1',
      browserTabId: 'browser-1',
      pageId: 'page-1',
      profileId: null,
      sessionPartition: null,
      groupId: 'g1',
      afterTabId: 'tab-1'
    }
    const page = { workspace: WORKTREE, browserTabId: 'browser-1', pageId: 'page-1' }

    expect(parse(open)?.success).toBe(true)
    expect(parse({ ...open, pageId: undefined })?.success).toBe(false)
    expect(parse({ ...open, browserTabId: '' })?.success).toBe(false)
    expect(parse({ ...open, index: -1 })?.success).toBe(false)
    expect(parse({ type: 'openBrowserPage', ...page })?.success).toBe(true)
    expect(parse({ type: 'closeBrowserPage', ...page })?.success).toBe(true)
    expect(parse({ type: 'replaceBrowserPage', ...page, newPageId: 'page-2' })?.success).toBe(true)
    expect(parse({ type: 'replaceBrowserPage', ...page })?.success).toBe(false)
    expect(
      parse({
        type: 'setBrowserTabProfile',
        workspace: WORKTREE,
        browserTabId: 'browser-1',
        profileId: 'p1',
        sessionPartition: null
      })?.success
    ).toBe(true)
  })

  it('takes a chat tab under the window’s id, with its place and creation time', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const open = {
      type: 'openAgentSessionTab',
      workspace: WORKTREE,
      tabId: 'structured-agent-session-chat-1',
      sessionId: 'chat-1',
      agent: 'codex',
      groupId: 'g1',
      afterTabId: 'tab-1',
      createdAt: 5,
      split: { besideGroupId: 'g0', direction: 'right' }
    }

    expect(parse(open)?.success).toBe(true)
    expect(parse({ ...open, tabId: undefined })?.success).toBe(false)
    expect(parse({ ...open, sessionId: '' })?.success).toBe(false)
    expect(parse({ ...open, index: -1 })?.success).toBe(false)
    // Only main's own restore and activation ask for a first surface.
    expect(apply?.params?.parse({ command: { ...open, initial: 'restore' } })).toEqual({
      command: open
    })
  })

  it('applies a browser tab’s record change to the workspace’s routed partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')
    const page = {
      type: 'openBrowserPage',
      workspace: WORKTREE,
      browserTabId: 'browser-1',
      pageId: 'page-2'
    } as const

    await runtime.applyLayoutCommand(page)

    expect(applyLayoutCommand).toHaveBeenCalledWith(page, ['local'])
  })

  it('accepts an editor open under the window’s tab id, its promote, and an unrecorded close', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const tab = { workspace: WORKTREE, tabId: 'tab-1' }
    const open = { type: 'openEditorTab', ...tab, fileId: '/work/one/a.ts', contentType: 'editor' }
    const file = { filePath: '/work/one/a.ts', relativePath: 'a.ts', language: 'typescript' }
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })

    expect(
      apply?.params?.parse({
        command: { ...open, file: { ...file, dirtyDraftContent: 'x' }, view: { mode: 'edit' } }
      })
    ).toEqual({ command: { ...open, file } })
    expect(parse({ ...open, preview: true, groupId: 'g1' })?.success).toBe(true)
    expect(parse({ ...open, tabId: undefined })?.success).toBe(false)
    expect(parse({ ...open, contentType: 'terminal' })?.success).toBe(false)
    expect(parse({ ...open, preview: false })?.success).toBe(false)
    expect(parse({ type: 'promotePreviewTab', ...tab })?.success).toBe(true)
    expect(
      apply?.params?.parse({ command: { type: 'closeTabs', workspace: WORKTREE, tabIds: ['e1'] } })
    ).toEqual({ command: { type: 'closeTabs', workspace: WORKTREE, tabIds: ['e1'] } })
  })

  it('accepts a simulator tab open under the window’s id, into its group or a new split', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const open = { type: 'openSimulatorTab', workspace: WORKTREE, tabId: 'sim-1', groupId: 'g1' }

    expect(parse({ ...open, afterTabId: 'tab-1', createdAt: 5 })?.success).toBe(true)
    expect(parse({ ...open, split: { besideGroupId: 'g0', direction: 'right' } })?.success).toBe(
      true
    )
    expect(parse({ ...open, tabId: undefined })?.success).toBe(false)
    expect(parse({ ...open, index: -1 })?.success).toBe(false)
  })

  it('accepts an editor tab move to the workspace the window resolved, naming its new ids', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const move = {
      type: 'moveTabToWorkspace',
      workspace: WORKTREE,
      toWorkspace: 'repo-1::/work/two',
      tabs: [{ tabId: 'e1', newTabId: 'e1', newEntityId: 'editor:two:/work/two/a.ts' }],
      groupId: 'g2',
      file: { filePath: '/work/two/a.ts', relativePath: 'a.ts', language: 'typescript' }
    }

    expect(parse(move)?.success).toBe(true)
    expect(parse({ ...move, file: undefined })?.success).toBe(true)
    expect(parse({ ...move, tabs: [] })?.success).toBe(false)
    expect(parse({ ...move, groupId: undefined })?.success).toBe(false)
    expect(parse({ ...move, toWorkspace: '' })?.success).toBe(false)
  })

  it('accepts open files renamed on disk under the window’s ids, with an edit file’s record', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const edit = {
      fileId: '/work/one/a.ts',
      newFileId: '/work/one/b.ts',
      record: {
        fromFilePath: '/work/one/a.ts',
        file: { filePath: '/work/one/b.ts', relativePath: 'b.ts', language: 'typescript' }
      }
    }
    const rename = { type: 'renameEditorFiles', workspace: WORKTREE, renames: [edit] }

    expect(parse(rename)?.success).toBe(true)
    expect(parse({ ...rename, renames: [{ fileId: 'd1', newFileId: 'd2' }] })?.success).toBe(true)
    expect(parse({ ...rename, renames: [] })?.success).toBe(false)
    expect(parse({ ...rename, renames: [{ ...edit, newFileId: '' }] })?.success).toBe(false)
    expect(
      parse({ ...rename, renames: [{ ...edit, record: { fromFilePath: 'x' } }] })?.success
    ).toBe(false)
  })

  it('takes an open into a new split under the window’s group id, on every open kind', async () => {
    const apply = (await registeredMethods(true)).find((method) => method.name === 'layout.apply')
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const split = { besideGroupId: 'g1', direction: 'right' }
    const opens = [
      {
        type: 'openEditorTab',
        workspace: WORKTREE,
        tabId: 'e1',
        fileId: '/a.ts',
        contentType: 'editor'
      },
      {
        type: 'openBrowserTab',
        workspace: WORKTREE,
        tabId: 'b1',
        browserTabId: 'b1',
        pageId: 'p1'
      },
      {
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        leafId: '11111111-1111-4111-8111-111111111111'
      }
    ]

    for (const open of opens) {
      expect(parse({ ...open, groupId: 'g2', split })?.success).toBe(true)
      expect(
        parse({ ...open, groupId: 'g2', split: { ...split, direction: 'center' } })?.success
      ).toBe(false)
      expect(parse({ ...open, groupId: 'g2', split: { direction: 'right' } })?.success).toBe(false)
    }
  })

  it('opens an editor tab in the workspace’s routed partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')
    const open = {
      type: 'openEditorTab',
      workspace: WORKTREE,
      tabId: 'editor-tab',
      fileId: '/work/one/a.ts',
      contentType: 'editor'
    } as const

    await runtime.applyLayoutCommand(open)

    expect(applyLayoutCommand).toHaveBeenCalledWith(open, ['local'])
  })

  it('accepts a sleep of one tab’s panes and a wake of exactly one pane', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const otherTabPane = 'tab-2:22222222-2222-4222-8222-222222222222'
    const record = {
      paneKey,
      worktreeId: WORKTREE,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1
    }
    const sleep = { type: 'sleep', workspace: WORKTREE, tabId: 'tab-1' }
    const wake = { type: 'wake', workspace: WORKTREE, tabId: 'tab-1' }

    expect(parse({ ...sleep, paneKeys: [paneKey], records: [record] })?.success).toBe(true)
    // Never the whole workspace, never past the tab, never a record for another pane or workspace.
    expect(parse({ ...sleep, records: [record] })?.success).toBe(false)
    expect(parse({ ...sleep, paneKeys: [otherTabPane], records: [] })?.success).toBe(false)
    expect(
      parse({ ...sleep, paneKeys: [paneKey], records: [{ ...record, paneKey: otherTabPane }] })
        ?.success
    ).toBe(false)
    expect(
      parse({ ...sleep, paneKeys: [paneKey], records: [{ ...record, worktreeId: 'repo-2::/x' }] })
        ?.success
    ).toBe(false)
    expect(parse({ ...wake, paneKeys: [paneKey] })?.success).toBe(true)
    expect(parse({ ...wake })?.success).toBe(false)
    expect(parse({ ...wake, paneKeys: [paneKey, paneKey] })?.success).toBe(false)
    expect(parse({ ...wake, paneKeys: [otherTabPane] })?.success).toBe(false)
  })

  it('accepts a record-only sleep and a record-only wake of any of one tab’s panes', () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parse = (command: Record<string, unknown>) => apply?.params?.safeParse({ command })
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const secondPane = 'tab-1:33333333-3333-4333-8333-333333333333'
    const otherTabPane = 'tab-2:22222222-2222-4222-8222-222222222222'
    const record = {
      paneKey,
      worktreeId: WORKTREE,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live'
    }
    const sleep = { type: 'sleep', workspace: WORKTREE, tabId: 'tab-1', recordOnly: true }
    const wake = { type: 'wake', workspace: WORKTREE, tabId: 'tab-1', recordOnly: true }

    expect(parse({ ...sleep, paneKeys: [paneKey], records: [record] })?.success).toBe(true)
    expect(parse({ ...wake, paneKeys: [paneKey, secondPane] })?.success).toBe(true)
    expect(parse({ ...wake, paneKeys: [paneKey, otherTabPane] })?.success).toBe(false)
    expect(parse({ ...wake, paneKeys: [] })?.success).toBe(false)
  })

  it('applies group sizes to the workspace’s routed partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')
    const ratios = {
      type: 'setGroupRatios',
      workspace: WORKTREE,
      groupLayout: { type: 'leaf', groupId: 'g1' }
    } as const

    await runtime.applyLayoutCommand(ratios)

    expect(applyLayoutCommand).toHaveBeenCalledWith(ratios, ['local'])
  })

  it('takes a terminal tab create under valid window ids, and only an activation initial', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const create = {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: 'tab-2',
      leafId: '22222222-2222-4222-8222-222222222222'
    }
    const accepts = (command: Record<string, unknown>): boolean | undefined =>
      apply?.params?.safeParse({ command }).success

    expect(
      apply?.params?.parse({
        command: { ...create, creation: { launchAgent: 'claude', startupCwd: '/work' }, index: 0 }
      })
    ).toEqual({ command: { ...create, creation: { launchAgent: 'claude', startupCwd: '/work' } } })
    expect(accepts({ ...create, initial: 'activation' })).toBe(true)
    expect(accepts({ ...create, initial: 'restore' })).toBe(false)
    expect(accepts({ ...create, tabId: 'web:surface' })).toBe(false)
    expect(accepts({ ...create, leafId: 'leaf-2' })).toBe(false)
    expect(accepts({ ...create, creation: { launchAgent: 'not-an-agent' } })).toBe(false)
  })

  it('creates a new tab in the workspace’s own partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')
    const create = {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: 'tab-new',
      leafId: '22222222-2222-4222-8222-222222222222'
    } as const

    await runtime.applyLayoutCommand(create)

    expect(applyLayoutCommand).toHaveBeenCalledWith(create, ['local'])
  })

  it('takes a tab’s titles, color, pin, view and ended launch agent, and no other property', async () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const tab = { workspace: WORKTREE, tabId: 'tab-1' }
    const parses = (command: Record<string, unknown>) =>
      apply?.params?.safeParse({ command: { ...tab, ...command } }).success

    expect(parses({ type: 'renameTab', kind: 'custom', title: ' Build ' })).toBe(true)
    expect(parses({ type: 'renameTab', kind: 'custom', title: null })).toBe(true)
    expect(parses({ type: 'renameTab', kind: 'generated', title: 'x' })).toBe(true)
    expect(parses({ type: 'renameTab', kind: 'generated', title: { agent: 'claude' } })).toBe(false)
    const vault = { agent: 'codex', sessionId: 's-1', title: 'Fix it' }
    expect(parses({ type: 'renameTab', kind: 'aiVault', title: vault })).toBe(true)
    expect(parses({ type: 'renameTab', kind: 'aiVault', title: null })).toBe(true)
    expect(parses({ type: 'renameTab', kind: 'aiVault', title: 'Fix it' })).toBe(false)
    expect(parses({ type: 'renameTab', kind: 'other', title: 'x' })).toBe(false)
    expect(parses({ type: 'setTabProps', color: '#f00', isPinned: true })).toBe(true)
    expect(parses({ type: 'setTabProps', color: null })).toBe(true)
    expect(parses({ type: 'setTabProps', isPinned: 'yes' })).toBe(false)
    expect(parses({ type: 'setTabProps', viewMode: 'chat', clearLaunchAgent: true })).toBe(true)
    expect(parses({ type: 'setTabProps', viewMode: 'split' })).toBe(false)
    expect(parses({ type: 'setTabProps', clearLaunchAgent: false })).toBe(false)
    expect(apply?.params?.parse({ command: { ...tab, type: 'setTabProps', title: 'x' } })).toEqual({
      command: { ...tab, type: 'setTabProps' }
    })
  })

  it('takes many tabs’ generated titles, of any workspaces, and no other title kind', () => {
    const apply = eraseRpcMethods(LAYOUT_APPLY_METHODS).find(
      (method) => method.name === 'layout.apply'
    )
    const parses = (command: Record<string, unknown>) =>
      apply?.params?.safeParse({ command: { type: 'renameTabs', ...command } }).success
    const titled = { workspace: WORKTREE, tabId: 'tab-1', title: 'Fix it' }

    expect(parses({ kind: 'generated', renames: [titled, { ...titled, title: null }] })).toBe(true)
    expect(parses({ kind: 'generated', renames: [] })).toBe(false)
    expect(parses({ kind: 'custom', renames: [titled] })).toBe(false)
    expect(parses({ kind: 'generated', renames: [{ ...titled, workspace: '' }] })).toBe(false)
    // A title that replaces the tab's first one reaches main as such.
    const replacing = { ...titled, replaceExisting: true }
    expect(
      apply?.params?.safeParse({
        command: { type: 'renameTabs', kind: 'generated', renames: [replacing] }
      }).data
    ).toEqual({ command: { type: 'renameTabs', kind: 'generated', renames: [replacing] } })
    expect(parses({ kind: 'generated', renames: [{ ...titled, replaceExisting: false }] })).toBe(
      false
    )
  })

  it('gives each title in its tab’s partition in one write, naming a paired server’s tab', async () => {
    const applyTabRenames = vi.fn(async (batches: { renames: { tabId: string }[] }[]) => [
      { rename: batches[0]!.renames[0]!, code: 'tab_not_found' }
    ])
    const hosts: Record<string, string> = { 'tab-1': 'local', 'tab-2': 'ssh:target-1' }
    const store = {
      getRepo: () => undefined,
      getWorkspaceSessionHostIds: () => ['local', 'ssh:target-1', 'runtime:env-1'],
      getWorkspaceSession: (host: string) => ({
        ...sessionListing('other'),
        tabsByWorktree: {},
        unifiedTabs: {
          [WORKTREE]: Object.entries({ ...hosts, 'tab-3': 'runtime:env-1' })
            .filter(([, owner]) => owner === host)
            .map(([id]) => ({ id, entityId: id, contentType: 'terminal' }))
        }
      }),
      applyTabRenames
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply path reads only these store methods.
    const runtime = new OrcaRuntimeService(store as never)
    const titled = (tabId: string) => ({ workspace: WORKTREE, tabId, title: `Title ${tabId}` })

    const reply = await runtime.applyLayoutCommand({
      type: 'renameTabs',
      kind: 'generated',
      renames: [titled('tab-1'), titled('tab-2'), titled('tab-3')]
    })

    const renameOf = (tabId: string) => ({ type: 'renameTab', kind: 'generated', ...titled(tabId) })
    expect(applyTabRenames).toHaveBeenCalledTimes(1)
    expect(applyTabRenames).toHaveBeenCalledWith([
      { hostId: 'local', renames: [renameOf('tab-1')] },
      { hostId: 'ssh:target-1', renames: [renameOf('tab-2')] }
    ])
    expect(reply).toEqual({
      ok: true,
      result: {
        untitled: [
          { workspace: WORKTREE, tabId: 'tab-3', code: 'host_not_owned' },
          { workspace: WORKTREE, tabId: 'tab-1', code: 'tab_not_found' }
        ]
      },
      frameSeq: 0
    })
  })

  it('names a title of a workspace a WSL move paused, and gives the others', async () => {
    const { runtime, applyTabRenames } = runtimeHolding('local')
    const paused = 'repo-1::/work/paused'
    frozen.workspaces.add(paused)

    const reply = await runtime.applyLayoutCommand({
      type: 'renameTabs',
      kind: 'generated',
      renames: [
        { workspace: WORKTREE, tabId: 'tab-1', title: 'Fix it' },
        { workspace: paused, tabId: 'tab-9', title: 'Paused' }
      ]
    })

    expect(applyTabRenames).toHaveBeenCalledWith([
      {
        hostId: 'local',
        renames: [
          {
            type: 'renameTab',
            kind: 'generated',
            workspace: WORKTREE,
            tabId: 'tab-1',
            title: 'Fix it'
          }
        ]
      }
    ])
    expect(reply).toMatchObject({
      ok: true,
      result: { untitled: [{ workspace: paused, tabId: 'tab-9', code: 'wsl_move_in_progress' }] }
    })
  })

  it('applies to the partition that holds the tab, such as an SSH host’s', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('ssh:target-1')

    await expect(runtime.applyLayoutCommand(SPLIT)).resolves.toEqual({
      ok: true,
      result: { leafId: 'minted' },
      // No one subscribes, so the stream has sent nothing.
      frameSeq: 0
    })
    expect(applyLayoutCommand).toHaveBeenCalledWith(SPLIT, ['ssh:target-1'])
  })

  it('names the stream position of the frame its write produced, sent before the reply', async () => {
    let session = sessionListing('tab-1')
    const written = new Set<(hostId: string | null) => void>()
    const order: string[] = []
    const store = {
      getRepo: () => undefined,
      getWorkspaceSessionHostIds: () => ['local'],
      getWorkspaceSession: () => session,
      onWorkspaceSessionWritten: (listener: (hostId: string | null) => void) => {
        written.add(listener)
        return () => written.delete(listener)
      },
      applyLayoutCommand: vi.fn(async () => {
        session = { ...session, activeTabId: null, tabsByWorktree: {} }
        written.forEach((listener) => listener('local'))
        return { ok: true, result: { leafId: 'minted' } }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the apply and stream paths read only these store methods.
    const runtime = new OrcaRuntimeService(store as never)
    const sent: number[] = []
    const { seq } = runtime.subscribeWorkspaceLayouts((event) => {
      order.push('frame')
      sent.push(event.seq!)
    })

    const reply = await runtime.applyLayoutCommand(SPLIT).then((value) => {
      order.push('reply')
      return value
    })

    expect(sent).toEqual([seq + 1])
    expect(reply.frameSeq).toBe(seq + 1)
    expect(order).toEqual(['frame', 'reply'])
  })

  it('refuses a paired server’s workspace, which keeps its mirrored layout', async () => {
    const { runtime, applyLayoutCommand } = runtimeHolding('runtime:env-1')

    await expect(runtime.applyLayoutCommand(SPLIT)).resolves.toEqual({
      ok: false,
      code: 'host_not_owned',
      frameSeq: 0
    })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })
})
