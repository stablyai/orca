import { expect, it } from 'vitest'
import { mapRuntimeError } from '../../responses/rpc-response'
import { CONNECTOR_REPLY_HTML_PAGE_AS_FILE } from '../../../../../shared/rpc-contract/connectors/connector-params'

// The CLI resends a refused page as a file only when this code survives the RPC reply.
it('keeps the html page refusal code on the wire', () => {
  const reply = mapRuntimeError(
    'req',
    { runtimeId: 'rt' },
    new Error(CONNECTOR_REPLY_HTML_PAGE_AS_FILE)
  )
  expect(reply.error.code).toBe('html_document_as_file')
})
