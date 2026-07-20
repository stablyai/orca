// Why: sequential teardown calls share one absolute deadline, while the mux expects relative timeouts.
export function sshPtyRelayTimeoutOptions(
  deadlineMs: number | undefined
): { timeoutMs: number } | undefined {
  return deadlineMs === undefined ? undefined : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }
}
