const RELEASE_NAME_TIME_ZONE = 'America/Los_Angeles'

/**
 * `07-31 13:54` — the timestamp segment of a dev build's release title, shown
 * verbatim in both the GitHub releases list and the in-app build picker.
 *
 * Why Pacific while the tag's own stamp stays UTC: that stamp is a sort key, and
 * a local one would repeat an hour at every DST fall-back, making two distinct
 * builds compare equal. A title is only ever read, so it uses the timezone the
 * people reading it are in. The two therefore disagree by the current offset.
 */
export function formatReleaseTitleTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Release title timestamp is invalid.')
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: RELEASE_NAME_TIME_ZONE,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // Why h23 rather than hour12: false: some ICU builds render midnight as 24.
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  )
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
