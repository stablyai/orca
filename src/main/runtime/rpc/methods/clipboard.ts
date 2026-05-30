import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { saveClipboardImageBufferAsTempFile } from '../../../window/clipboard-image-temp-file'

const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = 24 * 1024 * 1024

const SaveImageAsTempFile = z.object({
  contentBase64: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing image content' })
    .refine((value) => value.length <= MAX_CLIPBOARD_IMAGE_BASE64_CHARS, {
      message: 'Clipboard image is too large'
    })
    .refine(
      (value) => value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
      'Clipboard image content must be base64'
    ),
  connectionId: z.string().min(1).nullable().optional()
})

export const CLIPBOARD_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'clipboard.saveImageAsTempFile',
    params: SaveImageAsTempFile,
    handler: async (params) =>
      saveClipboardImageBufferAsTempFile(Buffer.from(params.contentBase64, 'base64'), {
        connectionId: params.connectionId
      })
  })
]
