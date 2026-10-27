import { useMemo } from 'react'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'
import { buildMobileSourceControlSections, type MobileGitStatusEntry } from './mobile-git-status'

export function useMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  entries: readonly TEntry[],
  groupOrder: SourceControlGroupOrder
) {
  return useMemo(() => buildMobileSourceControlSections(entries, groupOrder), [entries, groupOrder])
}
