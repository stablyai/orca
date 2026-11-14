import * as z from 'zod'
import {
  isPageStorageKey,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import { versionSchema } from './bridge-frame-fields'

export const BridgeStorageFrameSchema = z.object({
  v: versionSchema,
  type: z.literal('storage'),
  key: z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
  value: z.string().max(PAGE_STORAGE_MAX_VALUE_CHARS).nullable()
})
