import * as z from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

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
