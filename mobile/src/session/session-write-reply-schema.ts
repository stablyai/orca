import { z } from 'zod'
import { openEnum, salvagedOptional } from '../../../src/shared/zod-salvage'

// The session screen's writes: terminal input from native chat and the image surfaces, the tab
// strip's rename/close/activate, the New Tab terminal create, the terminal menu's display-mode
// toggle, the markdown tab save and the worktree review-notes write.
// Checked against the terminal-send envelope src/main/runtime/rpc/methods/terminal.ts answers with
// and RuntimeMarkdownSaveTabResult in src/shared/mobile-markdown-document.ts.

/**
 * The six writes whose reply body no call site reads.
 *
 * Rename, close, tab-close, focus, tab-activate and the review-notes write are all decided by the
 * acceptance verdict alone — use-mobile-session-close-actions.ts:50/76/113 read `accepted` and
 * nothing else, the two activation sends are never interpreted at all, and
 * use-mobile-session-diff-comments.ts:53 discards the interpretation. Declaring a member on any of
 * them would be a requirement with no reader behind it.
 */
export const sessionWriteUnreadReplySchema = z.unknown()

/**
 * The terminal tab a New Tab create answers with.
 *
 * `id` is required and non-empty: use-mobile-session-terminal-create-actions.ts reads it unguarded
 * three times — the pending-active ref, `setActiveSessionTabId` and the strip's dedupe — so a reply
 * without one seated a tab the strip could never address again. `type` is a literal because the
 * whole tab is spread into the strip, where `type` picks the arm: a create answering a markdown or
 * browser tab must be refused, not rendered as a terminal with no handle. `terminal`, `title` and
 * `terminalTheme` stay optional and keep main's own guards (`typeof === 'string'`, `||`, `??`)
 * behind them, and unknown members pass through so the strip keeps what a newer host sends.
 */
export const sessionCreatedTerminalTabSchema = z
  .looseObject({
    tab: z.looseObject({
      type: z.literal('terminal'),
      id: z.string().min(1),
      terminal: salvagedOptional('terminal', z.string().nullable()),
      title: salvagedOptional('title', z.string()),
      terminalTheme: salvagedOptional('terminalTheme', z.unknown())
    })
  })
  .transform((reply) => reply.tab)

const CHAT_VIEW_MODES = ['terminal', 'chat'] as const

/**
 * A fenced chat-pair write's reply. `chatView` is the pair the host now holds; a reply without it
 * comes from a host that does not own the pair, which the pending writer treats as a failure.
 * A malformed `chatView` refuses the whole reply rather than adopting a guessed pair. A view mode
 * this build does not know reads as `undefined`, never as a known mode; the sender defers it to
 * the snapshot.
 */
export const sessionTabChatViewReplySchema = z.looseObject({
  chatView: z
    .object({
      viewMode: openEnum(CHAT_VIEW_MODES, undefined).nullable(),
      chatLeafId: z.string().nullable()
    })
    .optional(),
  superseded: z.literal(true).optional()
})
