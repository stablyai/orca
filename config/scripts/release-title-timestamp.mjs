const RELEASE_NAME_TIME_ZONE = 'America/Los_Angeles'

/**
 * `Jul 31, 8:10PM` — the timestamp segment of a dev build's release title, shown
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
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  )
  // Assembled from parts rather than by string-editing the formatted output:
  // recent ICU separates the time from AM/PM with U+202F, not a plain space, so
  // a naive replace(' ', '') leaves the gap on some runtimes and not others.
  return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute}${parts.dayPeriod.toUpperCase()}`
}
