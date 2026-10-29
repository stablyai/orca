const RELEASE_NAME_TIME_ZONE = 'America/Los_Angeles'

// Show Pacific time in dev release titles; keep tag sort key UTC so DST fall-back cannot make distinct builds compare equal.
export function formatReleaseTitleTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Release title timestamp is invalid.')
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: RELEASE_NAME_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  )
  // Assemble parts: ICU can separate AM/PM with U+202F, which plain-space replacement misses.
  return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}${parts.dayPeriod.toUpperCase()}`
}
