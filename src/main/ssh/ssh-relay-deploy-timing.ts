// npm install on a cold Windows cache plus antivirus scanning can exceed the
// default 30s exec timeout.
export const NATIVE_DEPS_COMMAND_TIMEOUT_MS = 240_000

// Why: a missing binding can require both install and rebuild while the same
// install lock is held. Concurrent first installs must wait for that valid
// holder instead of failing halfway through its bounded work.
export const NATIVE_DEPS_REPAIR_BUDGET_MS = 2 * NATIVE_DEPS_COMMAND_TIMEOUT_MS

// Why: individual exec commands have their own timeouts, but the full deploy
// pipeline has no overall bound. Leave headroom after the native-deps budget
// for platform detection, upload, probes, and launch.
export const RELAY_DEPLOY_TIMEOUT_MS = NATIVE_DEPS_REPAIR_BUDGET_MS + 60_000
