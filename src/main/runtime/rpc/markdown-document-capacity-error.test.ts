import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'
import { MarkdownDocumentListingCapacityError } from '../../../shared/markdown-document-listing-limits'
import { RuntimeRpcEnvelopeSchema } from '../../../shared/runtime-rpc-envelope'

describe('Markdown document capacity errors across runtime RPC', () => {
  it('preserves the existing capacity code and useful message in the open error envelope', () => {
    const response = mapRuntimeError(
      'markdown-listing',
      { runtimeId: 'execution-host' },
      new MarkdownDocumentListingCapacityError()
    )
    expect(response).toEqual({
      id: 'markdown-listing',
      ok: false,
      error: {
        code: 'markdown_document_listing_capacity',
        message: 'Workspace is too large for Markdown link completion.'
      },
      _meta: { runtimeId: 'execution-host' }
    })
    expect(RuntimeRpcEnvelopeSchema.safeParse(response).success).toBe(true)
  })
})
