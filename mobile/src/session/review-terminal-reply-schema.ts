import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Require addressable terminal rows; salvage/drop other tab kinds rather than inventing send targets.
const reviewTerminalTabSchema = z
  .looseObject({
    type: z.literal('terminal'),
    id: z.string().min(1),
    terminal: z.string().min(1),
    title: salvagedOptional('title', z.string())
  })
  .transform((tab) => ({ id: tab.id, terminal: tab.terminal, title: tab.title ?? 'Terminal' }))

// Require an inventory array to distinguish malformed replies from no sessions; salvage valid rows independently.
export const reviewTerminalTabsSchema = z
  .looseObject({ tabs: salvagingArray(reviewTerminalTabSchema) })
  .transform((snapshot) => snapshot.tabs)

// An accepted create without a usable handle cannot deliver the following prompt.
export const reviewCreatedTerminalSchema = z
  .looseObject({ tab: reviewTerminalTabSchema })
  .transform((reply) => reply.tab)

// An absent accepted flag historically means success, but require an outer object so malformed replies cannot hide a lost prompt.
export const reviewTerminalSendAcceptedSchema = z
  .looseObject({
    send: salvagedOptional('send', z.looseObject({ accepted: z.unknown().optional() }))
  })
  .transform((reply) => reply.send?.accepted !== false)

export type MobileReviewTerminalTab = z.output<typeof reviewTerminalTabSchema>
