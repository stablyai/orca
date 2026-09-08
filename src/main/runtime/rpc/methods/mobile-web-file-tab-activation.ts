import { z } from 'zod'
import type { RpcContext } from '../core'
import { mobileWebSessionMethod } from './mobile-web-session-scope'

const list = mobileWebSessionMethod('session.tabs.list')
const activate = mobileWebSessionMethod('session.tabs.activate')

const FileTab = z.object({
  id: z.string().min(1),
  type: z.string(),
  mode: z.unknown().optional(),
  relativePath: z.unknown().optional(),
  diffSource: z.unknown().optional()
})
const TabSnapshot = z.object({ tabs: z.array(z.unknown()) })
const ActivateResult = z.object({ activeTabId: z.string().optional() })

// The renderer opens the tab asynchronously, so the newly opened tab appears a beat later.
const POLL_DELAYS_MS = [0, 300, 600, 900] as const

export type MobileWebFileTabTarget = {
  worktree: string
  relativePath: string
  mode: 'edit' | 'diff'
  staged: boolean
}

/** Brings the tab the host just opened to the front of the mobile session. */
export async function activateMobileWebFileTab(
  target: MobileWebFileTabTarget,
  context: RpcContext
): Promise<boolean> {
  for (const delayMs of POLL_DELAYS_MS) {
    await delay(delayMs)
    if (context.signal?.aborted) {
      return false
    }
    const tab = await findOpenedTab(target, context)
    if (tab && (await activateTab(target.worktree, tab.id, context))) {
      return true
    }
  }
  return false
}

async function findOpenedTab(
  target: MobileWebFileTabTarget,
  context: RpcContext
): Promise<z.infer<typeof FileTab> | null> {
  const snapshot = TabSnapshot.safeParse(
    await list.handler(list.params!.parse({ worktree: target.worktree }), context)
  )
  if (!snapshot.success) {
    return null
  }
  const matches = snapshot.data.tabs
    .map((tab) => FileTab.safeParse(tab))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter(
      (tab) =>
        tab.type !== 'browser' &&
        tab.type !== 'terminal' &&
        tab.relativePath === target.relativePath &&
        matchesMode(tab.mode, target.mode)
    )
  if (target.mode === 'edit') {
    return matches[0] ?? null
  }
  const source = target.staged ? 'staged' : 'unstaged'
  return (
    matches.find((tab) => tab.diffSource === source) ??
    matches.find((tab) => tab.diffSource == null) ??
    null
  )
}

function matchesMode(mode: unknown, expected: 'edit' | 'diff'): boolean {
  return expected === 'diff' ? mode === 'diff' : mode === 'edit' || mode == null
}

async function activateTab(worktree: string, tabId: string, context: RpcContext): Promise<boolean> {
  const result = ActivateResult.safeParse(
    await activate.handler(
      activate.params!.parse({
        worktree,
        tabId,
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }),
      context
    )
  )
  return result.success && result.data.activeTabId === tabId
}

async function delay(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  }
}
