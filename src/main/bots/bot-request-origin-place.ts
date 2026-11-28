// Where a turn started its work: the place every message or request that opened it carries, so a
// private ask taken beside a thread's never takes that thread's place.
import type { BotWakingPlace } from './bot-request-asker'

/** The one place every request started in; none when any started elsewhere or nowhere, or when a
 *  message beside the requests (the owner's, a person's) opened work of its own. A person's place is
 *  their channel, so its link tells two threads apart; two comments on one issue or pull request
 *  differ only in the link's `#` anchor, which never does. */
export function requestsOriginPlace(
  places: readonly (BotWakingPlace | undefined)[],
  besideRequests: boolean
): BotWakingPlace | undefined {
  const [first] = places
  return !besideRequests &&
    first &&
    places.every(
      (place) =>
        place?.source === first.source &&
        place.placeId === first.placeId &&
        page(place.url) === page(first.url)
    )
    ? first
    : undefined
}

const page = (url: string | undefined) => url?.split('#')[0]

/** Every message that opened the turn woke at the same place, or the turn names none. */
export const originOf = (
  places: (BotWakingPlace | undefined)[]
): { originPlace?: BotWakingPlace } => {
  const originPlace = requestsOriginPlace(
    places.map((place) => (place?.resultsElsewhere ? undefined : place)),
    false
  )
  return originPlace ? { originPlace } : {}
}
