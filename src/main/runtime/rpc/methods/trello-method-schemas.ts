import { z } from 'zod'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

export const VALID_FILTERS = ['assigned', 'allOpen', 'archived'] as const
export const TRELLO_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const TRELLO_DOWNLOAD_CHUNK_BASE64_CHARS = 512 * 1024

const VALID_UPLOAD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isValidBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value)
}

export const Connect = z.object({
  apiKey: requiredString('API key is required'),
  token: requiredString('Token is required')
})

export const BoardId = z.object({
  boardId: requiredString('Board ID is required')
})

export const CardId = z.object({
  cardId: requiredString('Card ID is required')
})

export const ImageUrl = z.object({
  url: requiredString('Image URL is required')
})

export const UploadAttachment = z.object({
  cardId: requiredString('Card ID is required'),
  name: requiredString('Attachment name is required'),
  mimeType: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value.trim() : ''))
    .pipe(
      z.enum(VALID_UPLOAD_MIME_TYPES, {
        message:
          'Unsupported image MIME type. Allowed: image/png, image/jpeg, image/gif, image/webp'
      })
    ),
  contentBase64: z
    .unknown()
    .refine((value) => typeof value === 'string', {
      message: 'Attachment content must be a string'
    })
    .refine((value) => isValidBase64(value as string), 'Attachment content is not valid base64')
})

export const ListCards = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    boardIds: z.array(z.string()).optional()
  })
  .optional()

export const SearchCards = z.object({
  query: requiredString('Missing search query'),
  limit: OptionalFiniteNumber,
  boardIds: z.array(z.string()).optional()
})

export const CreateCard = z.object({
  idBoard: requiredString('Board is required'),
  idList: requiredString('List is required'),
  name: requiredString('Title is required'),
  desc: OptionalPlainString
})

export const UpdateCard = z.object({
  cardId: requiredString('Card ID is required'),
  updates: z.object({
    name: OptionalString,
    desc: z.union([z.string(), z.undefined()]).optional(),
    idList: z.union([z.string(), z.null()]).optional(),
    closed: z.boolean().optional(),
    idMembers: z.array(z.string()).optional(),
    idLabels: z.array(z.string()).optional()
  })
})

export const CardComment = z.object({
  cardId: requiredString('Card ID is required'),
  text: requiredString('Comment text is required')
})

export const StartUpload = z.object({
  cardId: requiredString('Card ID is required'),
  name: requiredString('Attachment name is required'),
  mimeType: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value.trim() : ''))
    .pipe(
      z.enum(VALID_UPLOAD_MIME_TYPES, {
        message:
          'Unsupported image MIME type. Allowed: image/png, image/jpeg, image/gif, image/webp'
      })
    ),
  expectedBase64Length: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 1024 * 1024, 'Trello attachment is too large')
})

export const AppendUploadChunk = z.object({
  uploadId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  contentBase64: z
    .unknown()
    .refine((value): value is string => typeof value === 'string', {
      message: 'Missing chunk content'
    })
    .refine(
      (value) => value.length <= TRELLO_UPLOAD_CHUNK_BASE64_CHARS,
      'Trello upload chunk is too large'
    )
    .refine(isValidBase64, 'Trello upload chunk must be valid base64')
})

export const CommitUpload = z.object({
  uploadId: z.string().min(1)
})

export const AbortUpload = z.object({
  uploadId: z.string().min(1)
})

export const StartDownload = z.object({
  url: requiredString('Image URL is required')
})

export const ReadDownloadChunk = z.object({
  downloadId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(TRELLO_DOWNLOAD_CHUNK_BASE64_CHARS, 'Trello download chunk exceeds maximum allowed size')
})

export const AbortDownload = z.object({
  downloadId: z.string().min(1)
})
