import { describe, expect, it } from 'vitest'
import type { PersistedLaunchNoticeState } from '../../../src/shared/agent-launch-contract'
import { dropDismissedLaunchNotice } from './mobile-launch-notice-dismissal'

type Tab = { type: 'terminal' | 'markdown'; id: string; launchNotices?: PersistedLaunchNoticeState }

const notices = (
  launchToken: string,
  ...codes: PersistedLaunchNoticeState['notices'][number]['code'][]
): PersistedLaunchNoticeState => ({
  launchToken,
  notices: codes.map(
    (code) => ({ code, label: 'Claude' }) as PersistedLaunchNoticeState['notices'][number]
  )
})

describe('dropDismissedLaunchNotice', () => {
  it('removes only the dismissed code and keeps the rest', () => {
    const tabs: Tab[] = [
      {
        type: 'terminal',
        id: 'a',
        launchNotices: notices('lt-1', 'env_withheld', 'snapshot_definition_changed')
      }
    ]
    const next = dropDismissedLaunchNotice(tabs, 'lt-1', 'env_withheld')
    expect(next[0].launchNotices).toEqual(notices('lt-1', 'snapshot_definition_changed'))
  })

  it('drops the launchNotices object entirely when the last notice is dismissed', () => {
    const tabs: Tab[] = [
      { type: 'terminal', id: 'a', launchNotices: notices('lt-1', 'env_withheld') }
    ]
    const next = dropDismissedLaunchNotice(tabs, 'lt-1', 'env_withheld')
    expect(next[0]).not.toHaveProperty('launchNotices')
  })

  it('clears the code from every leaf sharing the launch token', () => {
    const tabs: Tab[] = [
      { type: 'terminal', id: 'a::1', launchNotices: notices('lt-1', 'env_withheld') },
      { type: 'terminal', id: 'a::2', launchNotices: notices('lt-1', 'env_withheld') }
    ]
    const next = dropDismissedLaunchNotice(tabs, 'lt-1', 'env_withheld')
    expect(next.every((tab) => tab.launchNotices === undefined)).toBe(true)
  })

  it('returns the same array reference when nothing matched (stale token)', () => {
    const tabs: Tab[] = [
      { type: 'terminal', id: 'a', launchNotices: notices('lt-1', 'env_withheld') }
    ]
    expect(dropDismissedLaunchNotice(tabs, 'stale-token', 'env_withheld')).toBe(tabs)
    expect(dropDismissedLaunchNotice(tabs, 'lt-1', 'snapshot_definition_changed')).toBe(tabs)
  })

  it('ignores tabs without launch notices', () => {
    const tabs: Tab[] = [{ type: 'markdown', id: 'md' }]
    expect(dropDismissedLaunchNotice(tabs, 'lt-1', 'env_withheld')).toBe(tabs)
  })
})
