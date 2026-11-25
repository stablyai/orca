/** `2026-11-19 09:00 (-05:00)`: this computer's time, with its offset so it reads anywhere.
 *  `exact` adds seconds, and milliseconds, when the time has them, so two near times differ. */
export function formatLocalTime(at: number, exact = false): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
  const ms = date.getMilliseconds()
  const seconds =
    exact && (date.getSeconds() > 0 || ms > 0)
      ? `:${two(date.getSeconds())}${ms > 0 ? `.${String(ms).padStart(3, '0')}` : ''}`
      : ''
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}${seconds} (${zone})`
}
