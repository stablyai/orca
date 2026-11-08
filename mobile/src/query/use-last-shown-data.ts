import { useState } from 'react'

/**
 * The query's data, or the last data this scope showed while a new key loads or a read fails, so another
 * HEAD or status read never blanks a screen. A different scope (another worktree or branch) starts empty.
 */
export function useLastShownData<T>(data: T | undefined, scope: string | null): T | undefined {
  const [shown, setShown] = useState<{ scope: string | null; data: T } | null>(null)
  if (data !== undefined && (shown?.data !== data || shown.scope !== scope)) {
    setShown({ scope, data })
  }
  return data ?? (shown && shown.scope === scope ? shown.data : undefined)
}
