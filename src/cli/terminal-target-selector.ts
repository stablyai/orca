import type { BrowserTabListResult, RuntimeTerminalListResult } from '../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

export function isBrowserTarget(target: string): boolean {
  return /^[@#]?b(?:rowser)?-?(\d+)$/i.test(target.trim())
}

export function parseBrowserIndex(target: string): number | null {
  const m = /^[@#]?b(?:rowser)?-?(\d+)$/i.exec(target.trim())
  return m ? Number.parseInt(m[1], 10) : null
}

export type ResolvedBrowserTarget = {
  browserPageId: string
  index: number
  url: string
  title: string
}

export async function resolveBrowserTarget(
  target: string,
  worktree: string | undefined,
  client: RuntimeClient
): Promise<ResolvedBrowserTarget> {
  const targetIdx = parseBrowserIndex(target)
  if (targetIdx === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Target "${target}" is not a valid browser target (e.g. @b1, @b2)`
    )
  }

  const listRes = await client.call<BrowserTabListResult>(
    'browser.tabList',
    worktree ? { worktree } : undefined
  )
  const tabs = listRes.result?.tabs ?? []
  if (tabs.length === 0) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No browser tabs found in worktree (target "${target}")`
    )
  }

  const matching = tabs.find(
    (t, idx) => t.index === targetIdx || (!t.index && idx + 1 === targetIdx)
  )
  if (!matching) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No browser tab found with index ${targetIdx} (target "${target}"). Available: ${tabs.map((_, i) => `@b${i + 1}`).join(', ')}`
    )
  }

  return {
    browserPageId: matching.browserPageId,
    index: targetIdx,
    url: matching.url,
    title: matching.title
  }
}

/**
 * Resolves a terminal target which can be a runtime handle, an index like '@1' or '#1',
 * or a label like '@codex'.
 */
export async function resolveTerminalTarget(
  target: string,
  worktree: string | undefined,
  client: RuntimeClient
): Promise<string> {
  const indexMatch = /^[@#]?(\d+)$/.exec(target.trim())
  const isLabelTarget = target.startsWith('@')
  if (!indexMatch && !isLabelTarget) {
    return target
  }

  const listRes = await client.call<RuntimeTerminalListResult>(
    'terminal.list',
    worktree ? { worktree } : undefined
  )
  const terminals = listRes.result.terminals

  if (indexMatch) {
    const targetIdx = Number.parseInt(indexMatch[1], 10)
    const matching = terminals.filter(
      (t, idx) => t.index === targetIdx || (!t.index && idx + 1 === targetIdx)
    )
    if (matching.length === 0) {
      throw new RuntimeClientError(
        'selector_not_found',
        `No terminal found with index ${targetIdx} (target "${target}")`
      )
    }
    if (matching.length > 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Ambiguous terminal target "${target}": matches ${matching.length} terminals. Specify a worktree.`
      )
    }
    return matching[0].handle
  }

  const rawLabel = target.slice(1).trim()
  const matching = terminals.filter(
    (t) => t.label === rawLabel || t.title === rawLabel || t.title === target
  )
  if (matching.length === 0) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No terminal found with label "${rawLabel}" (target "${target}")`
    )
  }
  if (matching.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous terminal target "${target}": matches ${matching.length} terminals. Use a unique label or handle.`
    )
  }
  return matching[0].handle
}
