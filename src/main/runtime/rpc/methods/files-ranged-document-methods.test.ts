import '../unused-default-rpc-methods.test-fixture'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RangedFileDocuments } from '../../../ipc/filesystem/ranged-file-documents'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { FILE_RANGED_DOCUMENT_METHODS } from './files-ranged-document-methods'

let folder: string
let filePath: string
let documents: RangedFileDocuments
let dispatcher: RpcDispatcher

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'orca-range-rpc-owner-'))
  filePath = join(folder, 'document.bin')
  await writeFile(filePath, Buffer.from([0, 1, 2, 255]))
  documents = new RangedFileDocuments()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This explicit registry only uses the real ranged-document owner and runtime id.
  const runtime = {
    getRuntimeId: () => 'runtime',
    rangedFileDocuments: {
      openTarget: (owner: string) => documents.open(owner, async () => filePath),
      read: documents.read.bind(documents),
      reload: documents.reload.bind(documents),
      status: documents.status.bind(documents),
      cancel: documents.cancel.bind(documents),
      close: documents.close.bind(documents)
    }
  } as unknown as OrcaRuntimeService
  dispatcher = new RpcDispatcher({ runtime, methods: FILE_RANGED_DOCUMENT_METHODS })
})

afterEach(async () => {
  await documents.closeOwner('in-process')
  await documents.closeOwner('connection-a')
  await documents.closeOwner('connection-b')
  await rm(folder, { recursive: true, force: true })
})

function dispatch(method: string, params: unknown, connectionId?: string) {
  return dispatcher.dispatch(
    { id: 'request', authToken: 'token', method, params },
    { connectionId }
  )
}

describe('ranged-document RPC connection authority', () => {
  it.each([undefined, ''])(
    'refuses every method without a stable connection (%s)',
    async (connectionId) => {
      const held = await documents.open('in-process', async () => filePath)
      const id = held.id
      const requests: [string, unknown][] = [
        ['files.rangeDocumentOpen', { worktree: 'id:workspace', relativePath: 'document.bin' }],
        ['files.rangeDocumentRead', { id, version: 1, offset: 0, length: 4, requestToken: 'read' }],
        ['files.rangeDocumentStatus', { id }],
        ['files.rangeDocumentCancel', { id, requestToken: 'read' }],
        ['files.rangeDocumentReload', { id }],
        ['files.rangeDocumentClose', { id }]
      ]
      for (const [method, params] of requests) {
        expect(await dispatch(method, params, connectionId)).toMatchObject({
          ok: false,
          error: { code: 'range_document_unsupported' }
        })
      }
      expect(
        await documents.read('in-process', {
          id,
          version: 1,
          offset: 0,
          length: 4,
          requestToken: 'retained'
        })
      ).toEqual({ version: 1, contentBase64: 'AAEC/w==', bytesRead: 4, eof: true })
    }
  )

  it('uses the authenticated connection for bytes, sibling isolation and disconnect cleanup', async () => {
    expect(
      await dispatch(
        'files.rangeDocumentOpen',
        {
          worktree: 'id:workspace',
          relativePath: 'document.bin'
        },
        'connection-a'
      )
    ).toMatchObject({
      ok: true,
      result: { version: 1, byteLength: 4, readOnly: true, isBinary: true, valid: true }
    })
    const held = await documents.open('connection-a', async () => filePath)
    const params = { id: held.id, version: 1, offset: 1, length: 3, requestToken: 'read' }
    expect(await dispatch('files.rangeDocumentRead', params, 'connection-a')).toMatchObject({
      ok: true,
      result: { version: 1, contentBase64: 'AQL/', bytesRead: 3, eof: true }
    })
    expect(await dispatch('files.rangeDocumentRead', params, 'connection-b')).toMatchObject({
      ok: false,
      error: { code: 'range_document_unknown' }
    })
    await documents.closeOwner('connection-a')
    expect(
      await dispatch('files.rangeDocumentStatus', { id: held.id }, 'connection-a')
    ).toMatchObject({
      ok: false,
      error: { code: 'range_document_unknown' }
    })
    expect(await dispatch('files.rangeDocumentRead', params, 'connection-a')).toMatchObject({
      ok: false,
      error: { code: 'range_document_unknown' }
    })
  })
})
