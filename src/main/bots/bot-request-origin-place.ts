// Where a turn woken by bot requests started its work: the place every request carries, so a private
// ask taken beside a thread's never takes that thread's place.
import type { BotWakingPlace } from './bot-request-asker'

/** The one place every request started in; none when any started elsewhere or nowhere, or when a
 *  message beside the requests (the owner's, a person's) opened work of its own. A person's place is
 *  their channel, so its link tells two threads apart. */
export function requestsOriginPlace(
  places: readonly (BotWakingPlace | undefined)[],
  besideRequests: boolean
): BotWakingPlace | undefined {
  const [first] = places
  return !besideRequests &&
    first &&
    places.every(
      (place) =>
        place?.source === first.source && place.placeId === first.placeId && place.url === first.url
    )
    ? first
    : undefined
}
