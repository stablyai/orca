import { z } from 'zod'

// Why: these ids shipped in older clients. `tolerateUnknownValues` would drop the
// whole statusBarItems field if one member failed to parse, silently discarding a
// paired old client's other toggles — so accept them on the wire and strip them.
const RETIRED_STATUS_BAR_ITEMS = ['gemini', 'antigravity'] as const

export const StatusBarItem = z.enum([
  'claude',
  'codex',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'ssh',
  'resource-usage',
  'ports',
  ...RETIRED_STATUS_BAR_ITEMS
])

type RetiredStatusBarItem = (typeof RETIRED_STATUS_BAR_ITEMS)[number]

export const RetainedStatusBarItems = z
  .array(StatusBarItem)
  .transform((items) =>
    items.filter(
      (item): item is Exclude<typeof item, RetiredStatusBarItem> =>
        !RETIRED_STATUS_BAR_ITEMS.includes(item as RetiredStatusBarItem)
    )
  )
