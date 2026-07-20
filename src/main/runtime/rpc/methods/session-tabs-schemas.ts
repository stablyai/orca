import { z } from 'zod'
import { MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../../../../shared/terminal-quick-commands'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { sleepingAgentLaunchConfigSchema } from '../../../../shared/workspace-session-sleeping-agents'
import { OptionalBoolean } from '../schemas'

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
  leafId: z.string().max(128).optional(),
  notifyClients: OptionalBoolean
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
  isPinned: z.boolean().optional(),
  // undefined = leave unchanged; no "clear" semantic (absence means default 'terminal').
  viewMode: z.enum(['terminal', 'chat']).optional()
})

export const CreateTerminalTab = WorktreeTabSelector.extend({
  afterTabId: z.string().optional(),
  targetGroupId: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  launchConfig: sleepingAgentLaunchConfigSchema,
  launchToken: z.string().min(1).max(128).optional(),
  agent: z
    .custom<TuiAgent>(isTuiAgent, {
      message: 'Unknown agent preset'
    })
    .optional(),
  // Why: agent prompts must be quoted and injected for the host shell (native,
  // WSL, or SSH) instead of pasted from the mobile client before the TUI is ready.
  agentPrompt: z
    .string()
    .max(MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)
    .refine((value) => value.trim().length > 0, { message: 'Agent prompt cannot be empty' })
    .optional(),
  // Why: `agent` is the legacy preset field; `launchAgent` is the launch-plan
  // identity used when preserving resume config across runtime boundaries.
  launchAgent: z
    .custom<TuiAgent>(isTuiAgent, {
      message: 'Unknown launch agent'
    })
    .optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  activate: z.boolean().optional(),
  // Why: idempotency key so a retried create (double-tap, reconnect replay)
  // returns the in-flight operation instead of spawning a duplicate terminal.
  clientMutationId: z.string().min(1).max(128).optional()
}).superRefine((value, context) => {
  if (value.agentPrompt !== undefined && value.agent === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['agentPrompt'],
      message: 'Agent prompt requires an agent preset'
    })
  }
  if (value.agentPrompt !== undefined && value.command !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['agentPrompt'],
      message: 'Agent prompt cannot be combined with a startup command'
    })
  }
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
