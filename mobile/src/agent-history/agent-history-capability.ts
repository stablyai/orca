// Why: mobile's protocol-version.ts is a separate copy without the capability
// constants (mirrors MOBILE_TASKS_CAPABILITY in tasks.tsx). Keep this string in
// lockstep with src/shared/protocol-version.ts AI_VAULT_RUNTIME_CAPABILITY.
export const MOBILE_AI_VAULT_CAPABILITY = 'aiVault.v1'

// Why: same lockstep as above, for src/shared/protocol-version.ts
// AI_VAULT_HOST_SCOPE_RUNTIME_CAPABILITY. A host without it drops executionHostScope and answers
// its own local scan, so the phone sends the scope (and the transcript probe) only when advertised.
export const MOBILE_AI_VAULT_HOST_SCOPE_CAPABILITY = 'aiVault.host-scope.v1'
