import { useMemo } from 'react'
import type { SourceControlGroupOrder } from '../../../../src/shared/ui-chrome/ui-chrome-types'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { buildMobileSourceControlSections } from './mobile-git-status'
import type { MobileGitStatusEntry } from '../git/git-status-reply-schema'

export function useMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  entries: readonly TEntry[],
  groupOrder: SourceControlGroupOrder
) {
  const t = useMobileTranslation()
  return useMemo(
    () => buildMobileSourceControlSections(entries, groupOrder, t),
    [entries, groupOrder, t]
  )
}
