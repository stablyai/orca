import { z } from 'zod'
import { salvagingArray } from '../../../src/shared/zod-salvage'

// `git.history` reply. Checked against GitHistoryResult in src/shared/git-history-types.ts, which
// src/main/runtime/rpc/methods/git.ts returns from getRuntimeGitHistory verbatim.
//
// The host publishes nine members; mobile reads one. `currentRef`, `remoteRef`, `baseRef`,
// `mergeBase`, `hasIncomingChanges`, `hasOutgoingChanges`, `hasMore` and `limit` have no reader in
// mobile/, so they are undeclared and pass through rather than becoming eight ways for an older
// host to fail.

/**
 * One commit row.
 *
 * `id` and `parentIds` are required: mobile-git-history.ts:48 calls `item.id.slice(0, 7)` and :51
 * indexes `item.parentIds[0]`, both of which throw on absence. `subject`, `author`, `displayId` and
 * `timestamp` are read through `||`, `??` or a nullish check on the same lines, so they are
 * optional here even where the host type declares them required — an older host that omits one
 * must still render a history list.
 */
const gitHistoryItemSchema = z.looseObject({
  id: z.string(),
  parentIds: z.array(z.string()),
  subject: z.string().optional(),
  displayId: z.string().optional(),
  author: z.string().optional(),
  // Nullish, not optional: the host sends `timestamp: null` for a commit with no date, and
  // formatCommitTime's guard is `== null`. A number-or-absent schema would drop the whole row.
  timestamp: z.number().nullish()
})

/**
 * `items` is required and fatal on absence: mapMobileCommitRows maps it with no guard, which is the
 * `Cannot read properties of null (reading 'items')` main records for every malformed partition.
 * A salvaging array so one unreadable commit drops out of the list instead of emptying the screen.
 */
export const gitHistoryResultSchema = z.looseObject({
  items: salvagingArray(gitHistoryItemSchema)
})

export type MobileGitHistoryResult = z.output<typeof gitHistoryResultSchema>
export type MobileGitHistoryItem = z.output<typeof gitHistoryItemSchema>
