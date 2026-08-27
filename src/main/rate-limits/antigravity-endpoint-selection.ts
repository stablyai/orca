export type AgyQuotaEndpoint = {
  pid: number
  port: number
  csrfToken: string | null
}

export async function inspectAgyProcessCommands(
  pids: Iterable<number>,
  inspect: (pid: number) => Promise<string>
): Promise<Map<number, string>> {
  const entries = await Promise.all(
    [...pids].map(async (pid) => {
      try {
        return [pid, await inspect(pid)] as const
      } catch {
        return null
      }
    })
  )
  return new Map(entries.filter((entry): entry is readonly [number, string] => entry !== null))
}

export function deduplicateAgyQuotaEndpoints(endpoints: AgyQuotaEndpoint[]): AgyQuotaEndpoint[] {
  const unique = new Map<string, AgyQuotaEndpoint>()
  for (const endpoint of endpoints) {
    const key = `${endpoint.pid}:${endpoint.port}`
    const current = unique.get(key)
    if (!current || (!current.csrfToken && endpoint.csrfToken)) {
      unique.set(key, endpoint)
    }
  }
  return [...unique.values()]
}
