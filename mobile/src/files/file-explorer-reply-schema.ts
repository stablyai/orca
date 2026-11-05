import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Require an array because the cache sorts/walks it unguarded. Drop rows without name or isDirectory; salvage decorative isSymlink.
export const fileDirectoryEntriesSchema = salvagingArray(
  z.looseObject({
    name: z.string(),
    isDirectory: z.boolean(),
    isSymlink: salvagedOptional('isSymlink', z.boolean())
  })
)

// Older hosts answer capped files.list: require files/truncated for cache construction and the cap notice; drop rows without a usable relativePath.
// basename/kind pass through for other readers; this consumer reads neither.
export const legacyFileListSchema = z.looseObject({
  files: salvagingArray(z.looseObject({ relativePath: z.string() })),
  truncated: z.boolean()
})
