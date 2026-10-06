// Enrollment, login replacement, and usage refresh must agree on one credential authority.
const mutations = new Map<string, Promise<void>>()

export function withClaudeAccountCredentialMutation<T>(
  accountId: string,
  operation: () => Promise<T>
): Promise<T> {
  const result = (mutations.get(accountId) ?? Promise.resolve()).then(operation)
  const settled = result.then(
    () => {},
    () => {}
  )
  mutations.set(accountId, settled)
  return result.finally(() => {
    if (mutations.get(accountId) === settled) {
      mutations.delete(accountId)
    }
  })
}
