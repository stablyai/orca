import { basename } from 'node:path'

/** The dated session folders Codex can be naming new rollouts in now, in local time. */
export function recentDates(): string[][] {
  const now = Date.now()
  return [-3, -2, -1, 0, 1].map((offset) => {
    // By calendar day: around a daylight-saving change a day isn't 24 hours.
    const day = new Date(now)
    day.setDate(day.getDate() + offset)
    return [
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    ]
  })
}

/** Whether a rollout's name carries one of these dates. */
export function isNamedOn(path: string, dates: readonly string[][]): boolean {
  return dates.some((parts) => basename(path).startsWith(`rollout-${parts.join('-')}T`))
}
