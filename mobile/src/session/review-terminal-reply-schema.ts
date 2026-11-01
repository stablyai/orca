import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { AGENT_STATUS_STATES } from '../../../src/shared/agent-status-types'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import {
  isMobileTerminalTabRunningAgent,
  resolveMobileTerminalTabOwnedAgentId
} from './mobile-terminal-tab-agent'

// Require addressable terminal rows; salvage/drop other tab kinds rather than inventing send targets.
const reviewTerminalTabSchema = z
  .looseObject({
    type: z.literal('terminal'),
    id: z.string().min(1),
    terminal: z.string().min(1),
    title: salvagedOptional('title', z.string()),
    // Which agent runs in it, so a note can go straight to the only one; older hosts send neither.
    launchAgent: salvagedOptional('launchAgent', z.string()),
    agentStatus: salvagedOptional(
      'agentStatus',
      z
        .looseObject({
          agentType: z.string().optional().catch(undefined),
          state: z.enum(AGENT_STATUS_STATES).optional().catch(undefined)
        })
        .nullable()
    )
  })
  .transform((tab) => {
    // The session strip's rule: an agent that finished and left a shell behind no longer counts.
    const identity = {
      title: tab.title ?? '',
      agentStatus: tab.agentStatus ?? null,
      launchAgent: tab.launchAgent && isTuiAgent(tab.launchAgent) ? tab.launchAgent : null
    }
    const agent = isMobileTerminalTabRunningAgent(identity)
      ? resolveMobileTerminalTabOwnedAgentId(identity)
      : null
    return {
      id: tab.id,
      terminal: tab.terminal,
      title: tab.title ?? 'Terminal',
      ...(agent ? { agent } : {})
    }
  })

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
