import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { JIRA_ATTACHMENT_IMAGE_METHODS } from './jira-attachment-image'
import {
  registerAttachmentImageGrant,
  resetAttachmentImageGrantsForTest
} from '../../../jira/attachments/image-grants'
import {
  clearAttachmentImagesForSite,
  _resetAttachmentImageCache
} from '../../../jira/attachments/image-cache'
import { decodeJiraImageFrame } from '../../../../shared/jira/jira-image-stream-frame'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../jira/attachments/image-read', () => ({ readGrantedAttachmentImage: read }))
const transferId = '12345678-1234-4234-8234-123456789012'
const runtime = { getRuntimeId: () => 'runtime' }
const dispatcher = new RpcDispatcher({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The image handler never calls runtime; this fixture implements the dispatcher's metadata read.
  runtime: runtime as unknown as OrcaRuntimeService,
  methods: JIRA_ATTACHMENT_IMAGE_METHODS
})
function request() {
  const url = registerAttachmentImageGrant(
    {
      site: { id: 'site', siteUrl: 'https://jira.test', email: '', accountId: '', displayName: '' },
      authorization: 'secret'
    },
    { id: '1', filename: 'image.png', mimeType: 'image/png', size: 1 }
  )
  return {
    id: 'image',
    authToken: 'token',
    method: 'jira.attachmentImage',
    params: { reference: url.split('/').at(-1), transferId }
  }
}
beforeEach(() => {
  _resetAttachmentImageCache()
  resetAttachmentImageGrantsForTest()
  read.mockReset().mockResolvedValue({ data: new Uint8Array(130_000), mimeType: 'image/png' })
})

describe('Jira image RPC carrier', () => {
  it('sends metadata, bounded addressed binary chunks and an end marker', async () => {
    const replies: string[] = []
    const frames: Uint8Array<ArrayBufferLike>[] = []
    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      sendBinary: (bytes) => {
        frames.push(bytes)
      }
    })
    expect(replies[0]).toContain('"byteLength":130000')
    expect(replies.at(-1)).toContain('"type":"end"')
    expect(frames).toHaveLength(2)
    expect(decodeJiraImageFrame(frames[0] ?? new Uint8Array(), transferId)?.bytes.byteLength).toBe(
      64 * 1024
    )
    expect(decodeJiraImageFrame(frames[1] ?? new Uint8Array(), transferId)?.sequence).toBe(1)
    expect(replies.join('')).not.toContain('secret')
  })
  it.each(['cancel', 'revoke', 'refuse'] as const)(
    'stops sending chunks after %s',
    async (action) => {
      const replies: string[] = []
      const controller = new AbortController()
      const binary = vi.fn(() => {
        if (action === 'cancel') {
          controller.abort()
        }
        if (action === 'revoke') {
          clearAttachmentImagesForSite('site')
        }
        return action !== 'refuse'
      })
      await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
        sendBinary: binary,
        signal: controller.signal
      })
      expect(binary).toHaveBeenCalledOnce()
      expect(replies.join('')).not.toContain('"type":"end"')
      expect(replies.at(-1)).toContain('"ok":false')
    }
  )
  it('requires a binary transport and rejects unknown grant references', async () => {
    const replies: string[] = []
    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply))
    expect(replies.join('')).toContain('binary subscription transport')
    expect(read).not.toHaveBeenCalled()
    const unknown = request()
    unknown.params.reference = '00000000-0000-0000-0000-000000000000'
    await dispatcher.dispatchStreaming(unknown, (reply) => replies.push(reply), {
      sendBinary: vi.fn()
    })
    expect(replies.join('')).toContain('unavailable')
    expect(read).not.toHaveBeenCalled()
  })
})
