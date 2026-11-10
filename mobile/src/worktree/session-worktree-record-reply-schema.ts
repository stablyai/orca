import * as z from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'
import type { WorktreeDisplayNameSource } from './worktree-display-name'

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
        path: salvagedOptional('path', z.string()),
        hostId: salvagedOptional('hostId', z.string()),
        repoId: salvagedOptional('repoId', z.string()),
        branch: salvagedOptional('branch', z.string().nullable()),
        diffComments: z.unknown().optional()
      })
    )
  })
  .transform(
    (
      reply
    ):
      | (WorktreeDisplayNameSource & {
          path?: string
          hostId?: string
          repoId?: string
          branch?: string | null
          diffComments?: unknown
        })
      | undefined => reply.worktree
  )
