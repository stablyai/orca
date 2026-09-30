import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The replies the session screen's launch paths read: opening a tapped file, creating a markdown
// note or a browser tab, the legacy-Codex resume repin, the structured-agent probe and create, and
// the session-option write. Checked against RuntimeFileOpenResult in
// src/shared/runtime-file-contracts.ts and the handlers in src/main/runtime/rpc/methods/files.ts,
// browser-core.ts, ai-vault.ts, agent-session.ts and client-ui.ts.

/**
 * Whether the host actually opened the tapped file.
 *
 * `opened` is required and boolean, because mobile-file-tap-open.ts:188 reads it with no guard and
 * routes the whole tap on it — main read a reply without one as "not opened", which is the same
 * answer a real `false` gets, so a host whose reply shape drifted was indistinguishable from one
 * that declined the open. An incompatible reply reaches the same `reportOpenFailure` through
 * openMobileFileTap's own catch.
 */
export const fileTapOpenedSchema = z.looseObject({ opened: z.boolean() })

/**
 * The browser tab a user opens from the tab strip.
 *
 * `browserPageId` is optional — use-mobile-session-content-create-actions.ts:126 reads it behind a
 * truthy check and only uses it to focus the new tab — but the object around it is required,
 * because main dereferenced the payload on that same line.
 */
export const browserTabCreatedSchema = z.looseObject({
  browserPageId: salvagedOptional('browserPageId', z.string())
})

/**
 * The legacy-Codex resume repin.
 *
 * Nullish and nothing required: ai-vault-resume-preparation.ts:53-58 reads both members through
 * `?.`, and an older host that cannot repin refuses rather than answering, which the call site
 * already handles off the raw reply. Both members are typed because both comparisons are exact —
 * `=== true` and `typeof === 'string'` — so a value of another type was never a repin.
 */
export const aiVaultResumePreparationSchema = z
  .looseObject({
    useRealCodexHome: salvagedOptional('useRealCodexHome', z.boolean()),
    substituteCodexHome: salvagedOptional('substituteCodexHome', z.string())
  })
  .nullish()

/**
 * The four launch replies no call site interprets.
 *
 * `files.createFile` is read for its refusal message only, the structured-agent probe and create
 * are examined envelope-first at the call site because anything they cannot prove is a definitive
 * refusal has to stay unknown, and the session-option write swallows every outcome. Declaring a
 * member on any of them would be a requirement with no reader behind it.
 */
export const sessionLaunchUnreadReplySchema = z.unknown()
