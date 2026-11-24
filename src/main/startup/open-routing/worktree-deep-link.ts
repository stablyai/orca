// orca://worktree?selector=<selector>: focus a worktree by any selector `orca worktree activate` takes.
export type WorktreeDeepLink = { selector: string }

const MAX_SELECTOR_LENGTH = 1024

export function parseWorktreeDeepLink(value: string): WorktreeDeepLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'orca:' || url.host !== 'worktree' || !/^\/?$/.test(url.pathname)) {
    return null
  }
  const selector = url.searchParams.get('selector')?.trim()
  return selector && selector.length <= MAX_SELECTOR_LENGTH ? { selector } : null
}

export function formatWorktreeDeepLink({ selector }: WorktreeDeepLink): string {
  return `orca://worktree?selector=${encodeURIComponent(selector)}`
}

type WorktreeFocuser = {
  canFocusManagedWorktree(): boolean
  focusManagedWorktree(selector: string): Promise<void>
}

/** Focuses the held link once a window can take it; a selector matching no worktree is dropped. */
export async function drainWorktreeDeepLink(
  deepLinks: { consumeWorktreeLink(): string | null },
  runtime: WorktreeFocuser | null
): Promise<void> {
  if (!runtime?.canFocusManagedWorktree()) {
    return
  }
  const selector = deepLinks.consumeWorktreeLink()
  if (!selector) {
    return
  }
  try {
    await runtime.focusManagedWorktree(selector)
  } catch (error) {
    console.warn('[deep-link] worktree link not opened', error)
  }
}
