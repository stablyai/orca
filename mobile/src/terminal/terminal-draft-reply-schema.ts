import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

/**
 * Host answers for the terminal draft editor. Every failure arm keeps the local text: a legacy
 * host's unknown-method refusal decodes as the operation policy's null, never as "saved".
 */
const draftConflictSchema = z.looseObject({
  text: z.string(),
  sourceToken: z.string()
})

const draftCapabilityFields = {
  supported: salvagedOptional('supported', z.boolean()),
  adapter: salvagedOptional('adapter', z.literal('pi-editor')),
  processIncarnation: salvagedOptional('processIncarnation', z.string()),
  reason: salvagedOptional('reason', z.string()),
  holder: salvagedOptional(
    'holder',
    z.looseObject({ clientId: z.string(), clientType: z.enum(['desktop', 'mobile']) })
  )
}

export const terminalDraftBeginSchema = z.looseObject({
  ok: z.boolean(),
  ...draftCapabilityFields,
  epoch: salvagedOptional('epoch', z.number().int().positive()),
  text: salvagedOptional('text', z.string()),
  sourceToken: salvagedOptional('sourceToken', z.string())
})

const draftSettlementFields = {
  ok: z.boolean(),
  status: z.string(),
  sourceToken: salvagedOptional('sourceToken', z.string()),
  replayed: salvagedOptional('replayed', z.boolean()),
  conflict: salvagedOptional('conflict', draftConflictSchema),
  epoch: salvagedOptional('epoch', z.number().int().nonnegative()),
  reason: salvagedOptional('reason', z.string()),
  submitRefused: salvagedOptional('submitRefused', z.boolean()),
  text: salvagedOptional('text', z.string()),
  normalized: salvagedOptional('normalized', z.boolean())
}

export const terminalDraftSaveSchema = z.looseObject(draftSettlementFields)
export const terminalDraftSubmitSchema = z.looseObject(draftSettlementFields)
export const terminalDraftReleaseSchema = z.looseObject({ ok: z.boolean() })
