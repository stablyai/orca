type Actor = { __typename?: string; login: string; avatarUrl?: string }

export function restIssueActor(actor: Actor | null): Record<string, unknown> | null {
  if (!actor) {
    return null
  }
  const login =
    actor.__typename === 'Bot' && !actor.login.endsWith('[bot]')
      ? `${actor.login}[bot]`
      : actor.login
  let avatar = actor.avatarUrl
  if (avatar) {
    const url = new URL(avatar)
    if (url.hostname === 'avatars.githubusercontent.com') {
      url.searchParams.delete('u')
      avatar = url.toString()
    }
  }
  return { login, avatar_url: avatar }
}
