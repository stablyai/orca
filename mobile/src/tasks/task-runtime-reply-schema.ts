import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Guarded capabilities may be absent; keep idempotency policy unknown for the caller’s distinct absent/null/object cases.
export const taskRuntimeStatusSchema = z.looseObject({
  capabilities: salvagedOptional('capabilities', salvagingArray(z.string())),
  worktreeCreateIdempotency: z.unknown().optional(),
  hostPlatform: salvagedOptional('hostPlatform', z.string())
})

// Persisted UI state is advisory: unreadable payloads hydrate defaults instead of failing the other request-group legs.
// Forward opaque trust/resume data for field-level narrowing at consumers.
export const taskUiStateSchema = z
  .looseObject({
    ui: salvagedOptional(
      'ui',
      z.looseObject({
        taskResumeState: z.unknown().optional(),
        trustedOrcaHooks: z.unknown().optional()
      })
    )
  })
  .nullish()
  .catch(undefined)
  .transform((reply) => reply?.ui)

// Advisory preflight must decode nullish replies as not installed; reader refusal would fail the whole hydration.
export const taskPreflightSchema = z
  .looseObject({
    glab: salvagedOptional(
      'glab',
      z.looseObject({ installed: salvagedOptional('installed', z.boolean()) })
    )
  })
  .catch({ glab: undefined })

// Nullish Linear probes mean not connected; workspace lists belong to another reader of this method.
export const taskLinearStatusSchema = z
  .looseObject({
    connected: salvagedOptional('connected', z.boolean())
  })
  .catch({ connected: undefined })

// These write bodies are unread; requiring members would introduce failures no consumer previously observed.
export const taskPreferenceWriteSchema = z.unknown()
