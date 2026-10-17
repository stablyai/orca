import { useEffect } from 'react'
import type { DebugSnapshot, DebugWorktree } from '../../../preload/api/debug-api'
import { keybindingMatchesAction } from '../../../shared/keybindings'
import {
  DEBUG_KEYBINDING_ACTION_IDS,
  type DebugKeybindingActionId
} from '../../../shared/keybindings/definitions-debug'
import { debugClient, type DebugClient } from '@/lib/debug/debug-client'
import { resolveDebugEditorContext } from '@/lib/debug/debug-editor-context'
import { debugSessionStore, type DebugSessionStore } from '@/lib/debug/use-debug-session'
import { requestRunAndDebug, type DebugOpenRunAndDebugDetail } from '@/lib/debug/debug-open-request'
import { normalizeRightSidebarRoute } from '@/store/right-sidebar-route'
import { useAppStore } from '@/store'
import { shortcutPlatform } from './app-window-chrome'

export {
  DEBUG_OPEN_RUN_AND_DEBUG_EVENT,
  type DebugOpenRunAndDebugDetail
} from '@/lib/debug/debug-open-request'

type DebugKeyClient = Pick<
  DebugClient,
  | 'snapshot'
  | 'previewLaunch'
  | 'start'
  | 'stop'
  | 'restart'
  | 'continue'
  | 'pause'
  | 'next'
  | 'stepIn'
  | 'stepOut'
  | 'listBreakpoints'
  | 'addBreakpoint'
  | 'removeBreakpoint'
>

export type DebugKeybindingDeps = {
  client?: DebugKeyClient
  store?: Pick<DebugSessionStore, 'getState' | 'ingestSnapshot'>
  openRunAndDebug?: (detail: DebugOpenRunAndDebugDetail) => void
}

// Why: terminals, browser guests and chat composers own their keys; F-keys there are not debug commands.
const FOREIGN_SURFACES = '.xterm, [data-browser-pane-id], webview, [data-native-chat-root]'
// Typed as string so this compiles before the 'debug' tab id joins the route union.
const DEBUG_TAB: string = 'debug'
const STEP_CALLS = {
  'debug.stepOver': 'next',
  'debug.stepInto': 'stepIn',
  'debug.stepOut': 'stepOut'
} as const

export function isForeignDebugKeyTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOREIGN_SURFACES) !== null
}

export function openRunAndDebug(detail: DebugOpenRunAndDebugDetail): void {
  const route = normalizeRightSidebarRoute(DEBUG_TAB)
  if (route.rightSidebarTab === DEBUG_TAB) {
    const state = useAppStore.getState()
    state.setRightSidebarTab(route.rightSidebarTab)
    state.setRightSidebarOpen(true)
  }
  requestRunAndDebug(detail)
}

function activeWorktreeTarget(): DebugWorktree | null {
  const state = useAppStore.getState()
  const context = resolveDebugEditorContext(state, state.activeWorktreeId ?? undefined, '')
  return context ? { repoId: context.repoId, worktreePath: context.rootPath } : null
}

function activeEditorBreakpointTarget() {
  const state = useAppStore.getState()
  const file = state.openFiles.find((candidate) => candidate.id === state.activeFileId)
  const line = file ? state.editorCursorLine[file.id] : undefined
  if (!file || file.mode !== 'edit' || !line) {
    return null
  }
  const context = resolveDebugEditorContext(state, file.worktreeId, file.filePath)
  return context ? { repoId: context.repoId, worktreePath: context.rootPath, file, line } : null
}

const slashes = (path: string): string => path.replace(/\\/g, '/')

const isLive = (snapshot: DebugSnapshot): boolean =>
  snapshot.status === 'starting' || snapshot.status === 'running' || snapshot.status === 'stopped'

async function startSelected(
  target: DebugWorktree,
  configName: string | null,
  deps: Required<DebugKeybindingDeps>
): Promise<void> {
  const { client, store, openRunAndDebug: open } = deps
  if (!configName) {
    open({ configName: null, confirm: false })
    return
  }
  const preview = await client.previewLaunch({ ...target, configName })
  if (!preview.ok) {
    open({ configName, confirm: false, message: preview.message })
    return
  }
  const { approved, expectedHash } = preview.value
  if (!approved.repo || !approved.adapter || !approved.launch) {
    open({ configName, confirm: true })
    return
  }
  const started = await client.start({ ...target, configName, expectedHash })
  if (started.ok) {
    store.ingestSnapshot(started.value)
  } else {
    open({ configName, confirm: false, message: started.message })
  }
}

async function toggleBreakpoint(client: DebugKeyClient): Promise<void> {
  const target = activeEditorBreakpointTarget()
  if (!target) {
    return
  }
  const { file, line, ...worktree } = target
  const [listed, snapshot] = await Promise.all([
    client.listBreakpoints(worktree),
    client.snapshot(worktree)
  ])
  if (!listed.ok) {
    return
  }
  // Core reports realpaths, so match by the worktree-relative path under core's root as well.
  const paths = new Set([slashes(file.filePath)])
  if (snapshot.ok && file.relativePath) {
    paths.add(`${slashes(snapshot.value.worktreePath)}/${slashes(file.relativePath)}`)
  }
  const existing = listed.value.find((bp) => bp.line === line && paths.has(slashes(bp.path)))
  await (existing
    ? client.removeBreakpoint({ ...worktree, id: existing.id })
    : client.addBreakpoint({ ...worktree, path: file.filePath, line }))
}

export async function runDebugKeybinding(
  actionId: DebugKeybindingActionId,
  deps: Required<DebugKeybindingDeps>
): Promise<void> {
  const { client, store } = deps
  if (actionId === 'debug.toggleBreakpoint') {
    return toggleBreakpoint(client)
  }
  const target = activeWorktreeTarget()
  if (!target) {
    return
  }
  const result = await client.snapshot(target)
  if (!result.ok) {
    if (actionId === 'debug.startOrContinue') {
      deps.openRunAndDebug({ configName: null, confirm: false, message: result.message })
    }
    return
  }
  const snapshot = result.value
  store.ingestSnapshot(snapshot)
  const session = store.getState(snapshot.worktreePath)
  const threadId = session.selectedThreadId ?? snapshot.stopped?.threadId ?? null
  const live = isLive(snapshot)
  switch (actionId) {
    case 'debug.startOrContinue':
      if (!live) {
        return startSelected(target, session.configName, deps)
      }
      if (snapshot.stopped && threadId !== null) {
        await client.continue({ ...target, threadId })
      }
      return
    case 'debug.stop':
    case 'debug.restart':
      if (live) {
        await (actionId === 'debug.stop' ? client.stop(target) : client.restart(target))
      }
      return
    case 'debug.pause': {
      const running = snapshot.status === 'running' && !snapshot.stopped
      const pauseThread = threadId ?? snapshot.threads[0]?.id
      if (running && pauseThread !== undefined) {
        await client.pause({ ...target, threadId: pauseThread })
      }
      return
    }
    case 'debug.stepOver':
    case 'debug.stepInto':
    case 'debug.stepOut':
      if (snapshot.stopped && threadId !== null) {
        await client[STEP_CALLS[actionId]]({ ...target, threadId })
      }
  }
}

const DEFAULT_DEPS: Required<DebugKeybindingDeps> = {
  client: debugClient,
  store: debugSessionStore,
  openRunAndDebug
}

/** Window keydown hook for the debug F-keys; mount once. */
export function useDebugKeybindings(overrides: DebugKeybindingDeps = {}): void {
  const { client, store, openRunAndDebug: open } = { ...DEFAULT_DEPS, ...overrides }
  useEffect(() => {
    const deps = { client, store, openRunAndDebug: open }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) {
        return
      }
      if (isForeignDebugKeyTarget(event.target)) {
        return
      }
      const { keybindings } = useAppStore.getState()
      const actionId = DEBUG_KEYBINDING_ACTION_IDS.find((id) =>
        keybindingMatchesAction(id, event, shortcutPlatform, keybindings, { context: 'app' })
      )
      if (!actionId) {
        return
      }
      if (actionId === 'debug.toggleBreakpoint') {
        // Editor scope: only with focus in a code editor, as VS Code's editorTextFocus.
        const inEditor =
          event.target instanceof Element && event.target.closest('.monaco-editor') !== null
        if (!inEditor || !activeEditorBreakpointTarget()) {
          return
        }
      } else if (!activeWorktreeTarget()) {
        return
      }
      event.preventDefault()
      void runDebugKeybinding(actionId, deps)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [client, store, open])
}
