import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'

export const WorktreeTabSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

export const SessionTabsUnsubscribe = WorktreeTabSelector.extend({
  subscriptionId: z.string().min(1).optional()
})

export const ActivateTab = WorktreeTabSelector.extend({
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id')),
  leafId: z.string().max(128).optional()
})

export type TerminalPaneLayoutNodeInput =
  | { type: 'leaf'; leafId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: TerminalPaneLayoutNodeInput
      second: TerminalPaneLayoutNodeInput
      ratio?: number
    }

// Why: this schema parses UNTRUSTED remote-client input. A recursive zod parse
// of a deeply-nested tree would overflow the main-process stack, so validate
// iteratively with hard depth + node-count caps before building the typed value.
const MAX_PANE_LAYOUT_DEPTH = 64
const MAX_PANE_LAYOUT_NODES = 1024

function parseTerminalPaneLayoutNode(value: unknown): TerminalPaneLayoutNodeInput | null {
  // Iterative validate-then-build: first walk the raw tree with an explicit
  // stack (no recursion) enforcing caps, then build bottom-up.
  let nodeCount = 0
  const stack: { raw: unknown; depth: number }[] = [{ raw: value, depth: 0 }]
  while (stack.length > 0) {
    const { raw, depth } = stack.pop()!
    if (depth > MAX_PANE_LAYOUT_DEPTH || ++nodeCount > MAX_PANE_LAYOUT_NODES) {
      return null
    }
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const node = raw as Record<string, unknown>
    if (node.type === 'leaf') {
      if (typeof node.leafId !== 'string' || node.leafId.length < 1 || node.leafId.length > 128) {
        return null
      }
      continue
    }
    if (node.type === 'split') {
      if (node.direction !== 'horizontal' && node.direction !== 'vertical') {
        return null
      }
      if (
        node.ratio !== undefined &&
        (typeof node.ratio !== 'number' || node.ratio < 0 || node.ratio > 1)
      ) {
        return null
      }
      stack.push({ raw: node.first, depth: depth + 1 }, { raw: node.second, depth: depth + 1 })
      continue
    }
    return null
  }
  return value as TerminalPaneLayoutNodeInput
}

const TerminalPaneLayoutNodeSchema = z
  .unknown()
  .transform((value) => parseTerminalPaneLayoutNode(value))
  .pipe(
    z.custom<TerminalPaneLayoutNodeInput>((value) => value !== null, {
      message: 'Invalid or too-deep pane layout tree'
    })
  )

export const UpdatePaneLayout = WorktreeTabSelector.extend({
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id')),
  root: z.union([z.null(), TerminalPaneLayoutNodeSchema]),
  expandedLeafId: z.string().max(128).nullable().optional(),
  titlesByLeafId: z.record(z.string(), z.string()).optional()
})

export const SetTabProps = WorktreeTabSelector.extend({
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id')),
  // undefined = leave unchanged; null = clear color / unset.
  color: z.string().max(64).nullable().optional(),
  isPinned: z.boolean().optional()
})

export const CreateTerminalTab = WorktreeTabSelector.extend({
  afterTabId: z.string().optional(),
  targetGroupId: z.string().optional(),
  command: z.string().optional(),
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  agent: z
    .custom<TuiAgent>(isTuiAgent, {
      message: 'Unknown agent preset'
    })
    .optional(),
  activate: z.boolean().optional()
})

const MoveTabBase = {
  worktree: WorktreeTabSelector.shape.worktree,
  tabId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing tab id')),
  targetGroupId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing target group id'))
} as const

export const MoveTab = z.discriminatedUnion('kind', [
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('reorder'),
      tabOrder: z.array(z.string().min(1)).min(1, 'Missing tab order')
    })
    .strict(),
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('move-to-group'),
      index: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      ...MoveTabBase,
      kind: z.literal('split'),
      splitDirection: z.enum(['left', 'right', 'up', 'down'])
    })
    .strict()
])

export const SaveMarkdownTab = ActivateTab.extend({
  baseVersion: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing base version')),
  content: z.string()
})
