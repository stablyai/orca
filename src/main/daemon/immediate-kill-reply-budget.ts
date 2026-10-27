// Import-free so runtime modules, and tests that mock the kill machinery, can read the budget.

// Leave room for capture and root exit within daemon-entry's 5s shutdown budget.
export const SHUTDOWN_DESCENDANT_VERIFY_MS = 2_500
export const SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS = 250
export const IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS = 8_000
export const SESSION_FORCE_KILL_RETRY_MS = 250
// Mirrors DESCENDANT_SNAPSHOT_TIMEOUT_MS, which immediate teardown's initial capture uses.
export const IMMEDIATE_KILL_CAPTURE_TIMEOUT_MS = 1_000

/** Include descendant capture, two overrunning table reads, a force-kill retry and physical-exit verification. */
export const IMMEDIATE_KILL_REPLY_BUDGET_MS =
  IMMEDIATE_KILL_CAPTURE_TIMEOUT_MS +
  SHUTDOWN_DESCENDANT_VERIFY_MS +
  2 * SHUTDOWN_DESCENDANT_TABLE_TIMEOUT_MS +
  SESSION_FORCE_KILL_RETRY_MS +
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
