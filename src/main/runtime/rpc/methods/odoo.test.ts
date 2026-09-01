import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  MAX_ODOO_ATTACHMENT_COUNT,
  ODOO_ATTACHMENT_UPLOAD_MAX_BASE64_LENGTH
} from '../../../../shared/odoo-attachment-upload-limit'
import { ODOO_METHODS } from './odoo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeFile(dataLength: number): { name: string; mimetype: string; data: string } {
  return { name: 'note.txt', mimetype: 'text/plain', data: 'a'.repeat(dataLength) }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    odooUploadTicketAttachments: vi.fn().mockResolvedValue({ ok: true, ids: [1] })
  } as unknown as OrcaRuntimeService
}

describe('odoo.uploadTicketAttachments params', () => {
  it('accepts a batch within the shared count and size caps', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: ODOO_METHODS })
    const files = Array.from({ length: MAX_ODOO_ATTACHMENT_COUNT }, () => makeFile(8))

    await dispatcher.dispatch(makeRequest('odoo.uploadTicketAttachments', { ticketId: 7, files }))

    expect(runtime.odooUploadTicketAttachments).toHaveBeenCalledWith(7, files, undefined)
  })

  it('rejects more files than the composer can stage', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: ODOO_METHODS })
    const files = Array.from({ length: MAX_ODOO_ATTACHMENT_COUNT + 1 }, () => makeFile(8))

    const response = await dispatcher.dispatch(
      makeRequest('odoo.uploadTicketAttachments', { ticketId: 7, files })
    )

    expect(response?.ok).toBe(false)
    expect(runtime.odooUploadTicketAttachments).not.toHaveBeenCalled()
  })

  it('rejects a payload over the size cap before it crosses the relay', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: ODOO_METHODS })
    const files = [makeFile(ODOO_ATTACHMENT_UPLOAD_MAX_BASE64_LENGTH + 1)]

    const response = await dispatcher.dispatch(
      makeRequest('odoo.uploadTicketAttachments', { ticketId: 7, files })
    )

    expect(response?.ok).toBe(false)
    expect(runtime.odooUploadTicketAttachments).not.toHaveBeenCalled()
  })
})
