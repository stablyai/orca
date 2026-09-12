import type { UiUpdateFields } from '../../../../shared/rpc-contract/client-ui-params'
export {
  FeatureInteractionIdParam,
  UiUpdate
} from '../../../../shared/rpc-contract/client-ui-params'

// The key/value parity assertions over this live in ui-state-schema-parity-checks.ts.
export type UiUpdateFieldsSchema = typeof UiUpdateFields
