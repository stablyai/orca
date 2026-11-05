import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C3_EXPLORER_CLOSURE_FAMILIES } from './c3-explorer-closure-families'
import { C3_PREVIEW_CLOSURE_FAMILIES } from './c3-preview-closure-families'
import type { PageClosurePins } from './page-closure'

// Measure the resolved explorer/preview web routes and inherit C1 pins verbatim; applying later classification rules to inherited families changes their verdicts.
// These recordings cover single save round trips, not retry/idempotency; files methods have no mobile streams.
export const C3_PAGE_CLOSURE: PageClosurePins = {
  ...C1_PAGE_CLOSURE,
  ...C3_EXPLORER_CLOSURE_FAMILIES,
  ...C3_PREVIEW_CLOSURE_FAMILIES
}
