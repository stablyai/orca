import { useMemo } from 'react'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { buildMobileSourceControlSections, type MobileGitStatusEntry } from './mobile-git-status'

export function useMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  entries: readonly TEntry[],
  groupOrder: SourceControlGroupOrder
) {
  // Section titles are translated inside the builder.
  const t = useMobileTranslation()
  return useMemo(
    () => buildMobileSourceControlSections(entries, groupOrder),
    [entries, groupOrder, t]
  )
}
