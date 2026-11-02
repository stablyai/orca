// npm install on a cold Windows cache plus antivirus scanning can exceed the
// default 30s exec timeout.
export const NATIVE_DEPS_COMMAND_TIMEOUT_MS = 240_000

// Why: a missing binding can require both install and rebuild while the same
// install lock is held. Concurrent first installs must wait for that valid
// holder instead of failing halfway through its bounded work.
const NATIVE_DEPS_REPAIR_BUDGET_MS = 2 * NATIVE_DEPS_COMMAND_TIMEOUT_MS

// Why: native repair also runs separately bounded chmod/probe/diagnostic/
// finalize commands around install + rebuild. Keep the outer bound above that
// valid worst path while remaining below the 20-minute stale-lock threshold.
export const RELAY_DEPLOY_TIMEOUT_MS = NATIVE_DEPS_REPAIR_BUDGET_MS + 7 * 60_000
