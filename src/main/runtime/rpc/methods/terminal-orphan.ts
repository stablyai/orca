import { z } from 'zod'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { isPtyIncarnationId, type PtyIncarnationId } from '../../../../shared/pty-incarnation'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { TerminalPaneLayoutNodeSchema } from './session-tabs-schemas'

function parseOrphanGroupLayout(value: unknown): TabGroupLayoutNode | null {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    if (
      current.depth > 64 ||
      ++count > 1_024 ||
      !current.value ||
      typeof current.value !== 'object'
    ) {
      return null
    }
    const node = current.value as Record<string, unknown>
    if (node.type === 'leaf') {
      if (
        typeof node.groupId !== 'string' ||
        node.groupId.length < 1 ||
        node.groupId.length > 256
      ) {
        return null
      }
      continue
    }
    if (
      node.type !== 'split' ||
      (node.direction !== 'horizontal' && node.direction !== 'vertical') ||
      (node.ratio !== undefined &&
        (typeof node.ratio !== 'number' ||
          !Number.isFinite(node.ratio) ||
          node.ratio < 0 ||
          node.ratio > 1))
    ) {
      return null
    }
    stack.push(
      { value: node.first, depth: current.depth + 1 },
      { value: node.second, depth: current.depth + 1 }
    )
  }
  return value as TabGroupLayoutNode
}

const TerminalOrphanGroupLayout = z
  .unknown()
  .transform(parseOrphanGroupLayout)
  .pipe(z.custom<TabGroupLayoutNode>((value) => value !== null, 'Invalid orphan group layout'))

const TerminalOrphanTopology = z.object({
  tabs: z
    .array(
      z.object({
        tabId: requiredString('Missing topology tab id').pipe(z.string().max(256)),
        root: TerminalPaneLayoutNodeSchema,
        activeLeafId: requiredString('Missing active leaf id').pipe(z.string().max(128)),
        expandedLeafId: z.string().max(128).nullable()
      })
    )
    .min(1)
    .max(64),
  groups: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        activeTabId: z.string().min(1).max(256),
        tabOrder: z.array(z.string().min(1).max(256)).min(1).max(64),
        recentTabIds: z.array(z.string().min(1).max(256)).max(64).optional()
      })
    )
    .min(1)
    .max(64),
  groupLayout: TerminalOrphanGroupLayout.optional()
})

const TerminalOrphanIncarnationId = z.custom<PtyIncarnationId>(
  isPtyIncarnationId,
  'Invalid PTY incarnation'
)

const TerminalAdoptOrphans = z.object({
  worktree: requiredString('Missing worktree selector').pipe(z.string().max(32_768)),
  expectedTopologyRevision: z.number().int().nonnegative(),
  claims: z
    .array(
      z.object({
        terminal: requiredString('Missing terminal handle').pipe(z.string().max(256)),
        ptyId: requiredString('Missing PTY id').pipe(z.string().max(8_192)),
        incarnationId: TerminalOrphanIncarnationId,
        tabId: requiredString('Missing tab id').pipe(z.string().max(256)),
        leafId: requiredString('Missing leaf id').pipe(z.string().max(128))
      })
    )
    .min(1)
    .max(64),
  activeTabId: OptionalString.pipe(z.string().max(256).optional()),
  activeGroupId: OptionalString.pipe(z.string().max(256).optional()),
  topology: TerminalOrphanTopology.optional()
})

export const TERMINAL_ORPHAN_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.adoptOrphans',
    params: TerminalAdoptOrphans,
    handler: async (params, { runtime }) => runtime.adoptTerminalOrphans(params)
  })
]
