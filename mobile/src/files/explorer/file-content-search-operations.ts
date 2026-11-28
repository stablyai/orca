import * as z from 'zod'
import { salvagedOptional, salvagingArray } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const matchSchema = z.looseObject({
  line: z.number(),
  column: z.number(),
  matchLength: z.number(),
  lineContent: z.string(),
  displayColumn: salvagedOptional('displayColumn', z.number()),
  displayMatchLength: salvagedOptional('displayMatchLength', z.number())
})

// Drop a malformed file or match rather than the whole answer; require only the container.
const fileContentSearchSchema = z.looseObject({
  files: salvagedOptional(
    'files',
    salvagingArray(
      z.looseObject({
        relativePath: z.string(),
        matches: salvagingArray(matchSchema)
      })
    )
  ),
  truncated: salvagedOptional('truncated', z.boolean())
})

export type FileContentSearchAnswer = z.output<typeof fileContentSearchSchema>

// Skip refusals: an unreadable workspace or a bad pattern shows no content hits, never an error over the name results.
export const fileContentSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.search-or-skip',
    method: 'files.search',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-content-search', fileContentSearchSchema)
  })
)
