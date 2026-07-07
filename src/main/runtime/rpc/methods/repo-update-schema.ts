import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString } from '../schemas'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'

export const RepoSourceControlAiOverrides = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value === null
        ? null
        : normalizeRepoSourceControlAiOverrides(value)
  )

const RepoBadgeColor = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : (normalizeRepoBadgeColor(value) ?? undefined)
  )

const RepoUpstream = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1)
  })
  .nullable()
  .optional()

export function createRepoUpdateSchema<T extends z.ZodRawShape>(
  selectorShape: T
): z.ZodObject<T & { updates: z.ZodObject<z.ZodRawShape> }> {
  return z.object({
    ...selectorShape,
    updates: z.object({
      displayName: OptionalString,
      badgeColor: RepoBadgeColor,
      repoIcon: z
        .unknown()
        .transform((value) => sanitizeRepoIcon(value))
        .optional(),
      upstream: RepoUpstream,
      hookSettings: z.unknown().optional(),
      worktreeBaseRef: OptionalString,
      worktreeBasePath: OptionalString,
      kind: z.enum(['git', 'folder']).optional(),
      symlinkPaths: z.array(z.string()).optional(),
      issueSourcePreference: z.enum(['auto', 'upstream', 'origin', 'mixed']).optional(),
      forkSyncMode: z.enum(['ask', 'safe-auto', 'off']).optional(),
      externalWorktreeVisibility: z.enum(['hide', 'show']).optional(),
      externalWorktreeVisibilityPromptDismissedAt: z.number().finite().optional(),
      externalWorktreeInboxBaselinePaths: z.array(z.string()).optional(),
      importedExternalWorktreePaths: z.array(z.string()).optional(),
      externalWorktreeDiscoverySuppressedAt: z.number().finite().nullable().optional(),
      projectGroupId: OptionalString.nullable().optional(),
      projectGroupOrder: OptionalFiniteNumber,
      sourceControlAi: RepoSourceControlAiOverrides
    })
  }) as z.ZodObject<T & { updates: z.ZodObject<z.ZodRawShape> }>
}
