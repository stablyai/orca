type AuthorityClient = { getGeneration?: () => number }

export type ClientAuthority = {
  client: AuthorityClient | null
  hostId: string
  executionHost: string | undefined
  worktreeId: string
}

export type ClientAuthorityToken = readonly [
  epoch: number,
  client: AuthorityClient | null,
  generation: number | undefined
]

// A monotonic count of authority changes, so work started under A is stale after A→B→A.
export function createClientAuthorityEpoch(): {
  update: (authority: ClientAuthority) => void
  token: () => ClientAuthorityToken
  isCurrent: (token: ClientAuthorityToken) => boolean
} {
  let epoch = 0
  let last: ClientAuthority | null = null
  return {
    update(authority) {
      if (
        last &&
        (last.client !== authority.client ||
          last.hostId !== authority.hostId ||
          last.executionHost !== authority.executionHost ||
          last.worktreeId !== authority.worktreeId)
      ) {
        epoch += 1
      }
      last = authority
    },
    token: () => [epoch, last?.client ?? null, last?.client?.getGeneration?.()],
    // Reads the generation live: migrateTo moves it without a render.
    isCurrent: ([tokenEpoch, client, generation]) =>
      tokenEpoch === epoch &&
      client === (last?.client ?? null) &&
      generation === client?.getGeneration?.()
  }
}
