import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_TASK_SOURCE_CLOSURE_FAMILIES } from './c2-task-source-closure-families'
import { C2_WORK_ITEM_CLOSURE_FAMILIES } from './c2-work-item-closure-families'
import type { PageClosurePins } from './page-closure'

// Measure the tasks .web route, excluding the native shell switch’s imports. Inherit C1 verdicts instead of applying C2’s new-family rule to them.
// Families with no byte-identical golden certify only stable divergence classification, not byte parity.
export const C2_PAGE_CLOSURE: PageClosurePins = {
  ...C1_PAGE_CLOSURE,
  ...C2_WORK_ITEM_CLOSURE_FAMILIES,
  ...C2_TASK_SOURCE_CLOSURE_FAMILIES
}
