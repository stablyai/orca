import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_TASK_SOURCE_CLOSURE_FAMILIES } from './c2-task-source-closure-families'
import { C2_WORK_ITEM_CLOSURE_FAMILIES } from './c2-work-item-closure-families'
import type { PageClosurePins } from './page-closure'

/**
 * The goldens recorded at a call site inside the C2 page closure, and what each one did at the
 * bridge.
 *
 * C2 moves the tasks screen to the web: `app/h/_layout.tsx` and `app/h/[hostId]/tasks.web.tsx` and
 * everything they import, 3767 modules of which 428 are this repository's own. 68 families and 257
 * goldens are recorded at a site inside it, and each is pinned by id to the verdict it gives — the
 * same instrument C1 and C5 use, for the same reason: `BRIDGED_PARITY_BASELINE` is counts over 786
 * goldens, and a count lets one of the other 530 pay for a closure golden that stopped replaying.
 *
 * The entry is the `.web.tsx` file, not the route switch beside it. Measured from
 * `app/h/[hostId]/tasks.tsx`, the closure is 3852 modules and 479 local and names
 * `mobileWeb.bundle-fetch` and `mobileWeb.bundle-manifest`: the switch imports the shell, and the
 * shell's own families are not the page's. The family set is the same 68 once those two are
 * removed, so the tell is what the extra modules are, not which goldens they reach.
 *
 * **C1's 20 families are inherited verbatim, not re-derived.** Run over the 94 inherited pins the
 * rule disagrees with 13 of them: all 7 in `tasks.smart-source-search`, a family that is
 * `params-undefined` throughout but is C1's own and so absent from the five the rule carries; all 5
 * in `host-worktree-refresh`, whose `write-ordinal` and `result-absent-stream-release` are shapes
 * the rule does not model at all; and `worktree-catalog-snapshot`, which the rule taints
 * `result-absent-settlement` because a sibling scenario in its family scripts an absent result. So
 * the spread below is the derivation for those, and the rule decides only the 48 families this
 * domain adds. C5's closure pins those same 20 and no family C2 reaches beyond them, so a golden
 * pinned twice is pinned once here.
 *
 * **What 257 certified does not say.** Six of the 68 families have no byte-identical golden at all
 * — `tasks.item-checks-files`, `tasks.project-row-files-merge`, `tasks.provider-load`,
 * `tasks.item-metadata-gitlab-mr`, `tasks.task-list-gitlab-items`, and C1's own
 * `host-worktree-refresh` — so for their 27 goldens the pin proves that the divergence kept its
 * name, and nothing more.
 */
export const C2_PAGE_CLOSURE: PageClosurePins = {
  ...C1_PAGE_CLOSURE,
  ...C2_WORK_ITEM_CLOSURE_FAMILIES,
  ...C2_TASK_SOURCE_CLOSURE_FAMILIES
}
