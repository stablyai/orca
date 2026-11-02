export function withAgentSessionAccountEnv(
  env: Record<string, string> | undefined,
  accountEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  return accountEnv && Object.keys(accountEnv).length > 0 ? { ...env, ...accountEnv } : env
}
