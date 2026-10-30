import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type { WorktreeDisplayNameSource } from './worktree-display-name'

// Require an inventory/handle for strip reconciliation; salvage individual malformed rows without erasing valid ones.
export const sessionTerminalInventorySchema = z.looseObject({
  terminals: salvagingArray(z.looseObject({ handle: z.string() }))
})

// Repo lookup needs only id; preserve remaining fields for each consumer’s own projection.
export const runtimeRepoListSchema = z
  .looseObject({ repos: salvagingArray(z.looseObject({ id: z.string() })) })
  .transform((reply) => reply.repos)

// Require the array before option construction spreads it; isMobileTuiAgent filters individual entries.
export const detectedAgentsSchema = z.array(z.unknown())

/** `preflight.refreshAgents` wraps the same list with PATH diagnostics the drawer never reads. */
export const refreshedAgentsSchema = z
  .looseObject({ agents: detectedAgentsSchema })
  .transform((reply) => reply.agents)

// Keep legacy missing/unreadable file lists empty; validate the container before projecting nonempty relative paths.
export const workspaceFilePathsSchema = z
  .looseObject({
    files: salvagedOptional(
      'files',
      salvagingArray(z.looseObject({ relativePath: salvagedOptional('relativePath', z.string()) }))
    )
  })
  .transform((reply) =>
    (reply.files ?? []).flatMap((file) => (file.relativePath ? [file.relativePath] : []))
  )

// Preserve null for unreadable canonical command lists so load/save cannot erase host commands with an invented empty list.
export const terminalQuickCommandsSchema = z
  .looseObject({ terminalQuickCommands: z.unknown().optional() })
  .nullish()
  .transform((reply) => reply?.terminalQuickCommands)

// Consumers guard these fields; salvage unreadable records as absent rather than failing unrelated reads.
export const sessionWorktreeRecordSchema = z
  .looseObject({
    worktree: salvagedOptional(
      'worktree',
      z.looseObject({
        worktreeId: salvagedOptional('worktreeId', z.string()),
        id: salvagedOptional('id', z.string()),
        displayName: salvagedOptional('displayName', z.string().nullable()),
        repo: salvagedOptional('repo', z.string().nullable()),
        diffComments: z.unknown().optional()
      })
    )
  })
  .transform(
    (reply): (WorktreeDisplayNameSource & { diffComments?: unknown }) | undefined => reply.worktree
  )

// Require editor content/version/dirty state; host capability and truncation metadata remain optional for compatibility.
export const markdownTabDocumentSchema = z.looseObject({
  content: z.string(),
  version: z.string(),
  isDirty: z.boolean(),
  editable: salvagedOptional('editable', z.boolean()),
  readOnlyReason: salvagedOptional('readOnlyReason', z.string()),
  truncated: salvagedOptional('truncated', z.boolean()),
  byteLength: salvagedOptional('byteLength', z.number())
})

// Keep generic tab snapshots and legacy error/window history unions opaque until callers can select their shape.
export const sessionForwardedReplySchema = z.unknown()

const skillProviders = z.array(z.enum(['codex', 'claude', 'agent-skills']))
const skillSourceKind = z.enum(['home', 'repo', 'bundled', 'plugin'])

// Rows a newer host shapes differently drop alone; the rest of the scan still lists.
export const skillDiscoveryReplySchema = z.looseObject({
  skills: salvagingArray(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      providers: skillProviders,
      sourceKind: skillSourceKind,
      sourceLabel: z.string(),
      rootPath: z.string(),
      rootPaths: z.array(z.string()).optional(),
      directoryPath: z.string(),
      skillFilePath: z.string(),
      installed: z.boolean(),
      updatedAt: z.number().nullable()
    })
  ),
  sources: salvagingArray(
    z.looseObject({
      id: z.string(),
      label: z.string(),
      path: z.string(),
      sourceKind: skillSourceKind,
      providers: skillProviders,
      owner: z.string().nullable(),
      exists: z.boolean()
    })
  )
})
