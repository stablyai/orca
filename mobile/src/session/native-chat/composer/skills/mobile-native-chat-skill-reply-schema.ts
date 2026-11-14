import * as z from 'zod'
import { salvagingArray } from '../../../../../../src/shared/zod-salvage'

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
