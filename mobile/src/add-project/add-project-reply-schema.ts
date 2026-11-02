import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Read only what the sheet shows or hands to New Workspace; the host list re-reads the full repo afterwards.
const addedProjectSchema = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  kind: salvagedOptional('kind', z.string())
})

export type AddedProject = z.output<typeof addedProjectSchema>

export const addedProjectReplySchema = z
  .looseObject({ repo: addedProjectSchema })
  .transform((reply) => reply.repo)

// repo.create reports validation failures as an accepted { error } body rather than an RPC error.
export const createProjectReplySchema = z.union([
  addedProjectReplySchema.transform((repo) => ({ added: true as const, repo })),
  z.looseObject({ error: z.string() }).transform((reply) => ({
    added: false as const,
    error: reply.error
  }))
])

export const hostDirectoryListingSchema = z.looseObject({
  resolvedPath: z.string(),
  entries: salvagingArray(
    z.looseObject({
      name: z.string(),
      isDirectory: z.boolean()
    })
  )
})

export type HostDirectoryListing = z.output<typeof hostDirectoryListingSchema>

export const gitAvailabilitySchema = z
  .looseObject({ available: z.boolean() })
  .transform((reply) => reply.available)
