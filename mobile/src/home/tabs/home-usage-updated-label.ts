import { translate, type Translate } from '../../i18n/mobile-i18n'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'

/** "Updated just now" or "Updated 5m ago", as the Usage tab and the usage widget show it. */
export function formatUsageUpdated(
  updatedAt: number,
  now: number,
  t: Translate = translate
): string {
  return now - updatedAt < 60_000
    ? t('home.usage.updatedJustNow', 'Updated just now')
    : t('home.usage.updatedAgo', 'Updated {{time}} ago', {
        time: formatTimeAgo(updatedAt, now, t)
      })
}
