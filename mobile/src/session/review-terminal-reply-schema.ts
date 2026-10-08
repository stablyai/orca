import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The three replies the review send sheet and the PR triage actions read:
// `session.tabs.createTerminal`, `session.tabs.list` and `terminal.send`. Checked against
// RuntimeMobileSessionCreateTerminalResult / RuntimeMobileSessionTabs in src/shared/runtime-types.ts,
// which src/main/runtime/rpc/methods/session-tabs.ts:24-60 returns from the runtime verbatim, and
// against the terminal-send envelope src/main/runtime/rpc/methods/terminal.ts answers with.

/**
 * One agent terminal the sheet can drop a prompt into.
 *
 * `id` and `terminal` are required and non-empty because pr-ai-triage-launch.ts:33 addresses the
 * follow-up `terminal.send` at `terminalTab.terminal`, and the sheet keys its rows by `id`; main
 * dropped a row missing either with a falsy check, which `.min(1)` is. `type` is a literal rather
 * than an open enum because it is the discriminant that selects terminal tabs out of a snapshot
 * carrying file, markdown and browser tabs — an unknown kind must drop out of the list, not
 * degrade into a terminal the sheet would then address.
 */
const reviewTerminalTabSchema = z
  .looseObject({
    type: z.literal('terminal'),
    id: z.string().min(1),
    terminal: z.string().min(1),
    title: salvagedOptional('title', z.string())
  })
  .transform((tab) => ({ id: tab.id, terminal: tab.terminal, title: tab.title ?? 'Terminal' }))

/**
 * The agent terminals the send sheet lists.
 *
 * `tabs` is required: use-mobile-diff-review-send-actions.ts:141 renders the list it returns, and
 * main answered a snapshot with no array with an empty sheet that read as "this worktree has no
 * agent sessions". A salvaging array, so a single unreadable row drops the way a non-terminal tab
 * already does instead of emptying the sheet.
 */
export const reviewTerminalTabsSchema = z
  .looseObject({ tabs: salvagingArray(reviewTerminalTabSchema) })
  .transform((snapshot) => snapshot.tabs)

/**
 * The tab a create answers with.
 *
 * `tab` is required, and so is its terminal handle: pr-ai-triage-launch.ts:32 addresses the prompt
 * send at it, and a create that named no usable terminal was already a dead end — both callers
 * turned main's null into "Created terminal response was invalid" on the next line. Refusing here
 * puts the method in that message and deletes the branch.
 */
export const reviewCreatedTerminalSchema = z
  .looseObject({ tab: reviewTerminalTabSchema })
  .transform((reply) => reply.tab)

/**
 * Whether an accepted send was taken by the runtime.
 *
 * Nothing is required: main read `send.accepted !== false`, so a reply with no envelope at all was
 * an accepted send, and a host that stops sending the envelope must not start reporting a locked
 * terminal. What the schema adds is the outer object — main read a string or a null reply as
 * accepted, which is the shape that hides a lost prompt.
 */
export const reviewTerminalSendAcceptedSchema = z
  .looseObject({
    send: salvagedOptional('send', z.looseObject({ accepted: z.unknown().optional() }))
  })
  .transform((reply) => reply.send?.accepted !== false)

export type MobileReviewTerminalTab = z.output<typeof reviewTerminalTabSchema>
