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

type WorktreeActivator = {
  activateManagedWorktree(selector: string): Promise<unknown>
}

/** Same path as `orca worktree activate`; an unknown or ambiguous selector leaves the window as it is. */
export async function openWorktreeDeepLink(
  link: WorktreeDeepLink,
  runtime: WorktreeActivator | null
): Promise<boolean> {
  if (!runtime) {
    return false
  }
  try {
    await runtime.activateManagedWorktree(link.selector)
    return true
  } catch (error) {
    console.warn('[deep-link] worktree link not opened', error)
    return false
  }
}
