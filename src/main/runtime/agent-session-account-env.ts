/** The agent's launch env with a desktop-prepared account env (`accountEnv`) laid over it, as a
 *  local launch's auth patch is; unchanged when there is none. */
export function withAgentSessionAccountEnv(
  env: Record<string, string> | undefined,
  accountEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  return accountEnv && Object.keys(accountEnv).length > 0 ? { ...env, ...accountEnv } : env
}
