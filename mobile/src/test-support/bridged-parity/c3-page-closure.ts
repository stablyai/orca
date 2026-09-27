import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C3_EXPLORER_CLOSURE_FAMILIES } from './c3-explorer-closure-families'
import { C3_PREVIEW_CLOSURE_FAMILIES } from './c3-preview-closure-families'
import type { PageClosurePins } from './page-closure'

/**
 * The goldens recorded at a call site inside the C3 page closure, and what each one did at the
 * bridge.
 *
 * C3 moves the files domain to the web: `app/h/_layout.tsx` and the two files routes and
 * everything they import. Measured at this base, the explorer is 3441 modules of which 304 are
 * this repository's own and 10 are under `src/files`, the preview 3666 / 330 / 19, and their union
 * is 342 local modules. 26 families and 116 goldens are recorded at a site inside that union, each
 * pinned by id to the verdict it gives — the instrument C1, C2 and C5 use, for the reason
 * `BRIDGED_PARITY_BASELINE` cannot serve: it is counts over 787 goldens, so one of the other 671
 * can pay for a closure golden that stopped replaying.
 *
 * The entries are the `.web.tsx` files, not the route switches beside them. Measured from the
 * switches the closure names no extra family here — `mobileWeb.*` is absent either way, because
 * neither switch's shell import reaches a recorded site — but it carries `MobileWebShellScreen`
 * and six more modules, and the rule is to measure what the browser loads.
 *
 * **C1's 20 families are inherited verbatim, not re-derived.** Run over those 94 pins, C2's
 * classification rule disagrees with 13: all 7 in `tasks.smart-source-search`, which is
 * `params-undefined` throughout but is C1's own and so outside the five families the rule carries;
 * all 5 in `host-worktree-refresh`, whose `write-ordinal` and `result-absent-stream-release` are
 * shapes the rule does not model; and `worktree-catalog-snapshot`, which the rule taints
 * `result-absent-settlement` because a sibling scenario in its family scripts an absent result. So
 * the spread below is the derivation for those, and the rule decides only the 6 families this
 * domain adds. C5's closure pins the same 20 and C2's closure adds none of C3's six, so every
 * family pinned twice is pinned once here.
 *
 * **What 116 certified does not say.** One family has no byte-identical golden at all —
 * `host-worktree-refresh`, inherited from C1 — so for its 5 goldens the pin proves that the
 * divergence kept its name and nothing more. Every one of C3's own six families has at least one
 * golden that replays byte for byte.
 *
 * **What no golden here exercises.** No scenario replays a save twice, so
 * `files.writeTerminalArtifact` is certified for one round trip and not for idempotency or retry;
 * and nothing in this corpus subscribes on a files method, because the domain opens no stream —
 * `files.watch` exists on the desktop and is absent from the mobile allowlist. The one stream in
 * this closure is `runtime.clientEvents.subscribe`, reached through the shared host layout and
 * pinned by C1's `host-worktree-refresh`.
 */
export const C3_PAGE_CLOSURE: PageClosurePins = {
  ...C1_PAGE_CLOSURE,
  ...C3_EXPLORER_CLOSURE_FAMILIES,
  ...C3_PREVIEW_CLOSURE_FAMILIES
}
