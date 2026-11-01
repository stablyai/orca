import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Require an explicit opened verdict so malformed replies cannot masquerade as declined opens.
export const fileTapOpenedSchema = z.looseObject({ opened: z.boolean() })

// Require the reply object; browserPageId is only a guarded optional focus hint.
export const browserTabCreatedSchema = z.looseObject({
  browserPageId: salvagedOptional('browserPageId', z.string())
})

// Older hosts may return no repin data; retain exact boolean/string guards and handle unsupported-method refusal before parsing.
export const aiVaultResumePreparationSchema = z
  .looseObject({
    useRealCodexHome: salvagedOptional('useRealCodexHome', z.boolean()),
    substituteCodexHome: salvagedOptional('substituteCodexHome', z.string())
  })
  .nullish()

// Leave unread replies opaque; structured creates/probes require raw-envelope uncertainty checks at their callers.
export const sessionLaunchUnreadReplySchema = z.unknown()
