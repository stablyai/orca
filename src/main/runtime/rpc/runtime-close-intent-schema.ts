import { z } from 'zod'
import type { RuntimeCloseIntentSource } from '../../../shared/runtime-close-intent'

const RUNTIME_CLOSE_INTENT_SOURCES = [
  'user-tab-close',
  'user-pane-close',
  'user-bulk-close',
  'cli',
  'automation',
  'client-created-rollback',
  'lifecycle-cleanup',
  'pty-exit-echo',
  'mirror-detached'
] as const satisfies readonly RuntimeCloseIntentSource[]

export const RuntimeCloseIntentSchema = z.object({
  source: z.enum(RUNTIME_CLOSE_INTENT_SOURCES),
  userInitiated: z.boolean(),
  requestId: z.string().min(1).max(128),
  occurredAt: z.number().int().nonnegative(),
  worktreeId: z.string().min(1).max(2048),
  clientTabId: z.string().min(1).max(512).optional(),
  hostTabId: z.string().min(1).max(512).optional(),
  ptyOrHandle: z.string().min(1).max(2048).optional()
})
