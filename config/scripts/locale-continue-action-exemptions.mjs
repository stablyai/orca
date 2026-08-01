// Distinguishes the "continue" action label from the Continue agent product so the brand
// revert and the never-translate guard don't force plain UI buttons back to Latin.

// Multi-word "Continue …" labels always name the action, never the Continue agent.
const CONTINUE_ACTION_ENVALUES = new Set(['Continue in New Session', 'Continue in New Session…'])

// Bare "Continue" is ambiguous; these keys are action buttons. The agent catalog keeps its own
// bare "Continue" (auto.lib.agent.catalog.*), which stays Latin.
const CONTINUE_ACTION_KEYS = new Set(['auto.components.mobile.MobileHero.a8fb43cf1c'])

export function isContinueActionContext(brand, enValue, key) {
  if (brand !== 'Continue') {
    return false
  }
  return CONTINUE_ACTION_ENVALUES.has(enValue) || CONTINUE_ACTION_KEYS.has(key)
}

export function isContinueActionValue(enValue, key) {
  return isContinueActionContext('Continue', enValue, key)
}
