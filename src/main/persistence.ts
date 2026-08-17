export { Store, type PtyBindingSourceExpectation } from './persistence/loading-store/store'
export {
  getCanonicalUserDataPath,
  initDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from './persistence/loading-store/user-data-path'
export { normalizeRightSidebarTab } from './persistence/applying-settings/ui-selection-normalization'
export { sanitizeOnboardingUpdate } from './persistence/applying-settings/onboarding-normalization'
