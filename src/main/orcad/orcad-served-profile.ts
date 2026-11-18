// The Orca profile this orcad opened at startup, which it serves for the process's life.

let served: string | null = null

export function recordOrcadServedProfile(profileId: string): void {
  served = profileId
}

/** Null before a profile opens: nothing is served yet. */
export function orcadServedProfileId(): string | null {
  return served
}
