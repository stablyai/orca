// A pairing save publishes metadata, token and relay routing as separate writes; host list reads wait it
// out instead of returning the half-published host (for a re-pair, the old cached token with no relay).
const pendingPublications = new Set<Promise<void>>()

// A hung keychain write must not freeze every host list read.
const MAX_PUBLICATION_WAIT_MS = 5_000

export function trackPairingPublication(publish: () => Promise<void>): Promise<void> {
  const publication = publish()
  const settled = publication.then(
    () => {},
    () => {}
  )
  pendingPublications.add(settled)
  void settled.then(() => pendingPublications.delete(settled))
  return publication
}

export async function pairingPublicationsSettled(): Promise<void> {
  if (pendingPublications.size === 0) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitedTooLong = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, MAX_PUBLICATION_WAIT_MS)
  })
  try {
    await Promise.race([allPublicationsSettled(), waitedTooLong])
  } finally {
    clearTimeout(timer)
  }
}

// Publications can start while earlier ones settle, so loop until none is pending.
async function allPublicationsSettled(): Promise<void> {
  while (pendingPublications.size > 0) {
    await Promise.all(pendingPublications)
  }
}
