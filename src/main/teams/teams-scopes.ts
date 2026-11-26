// The delegated Microsoft Graph permissions a Teams sign-in asks for: the least each verb needs.
// ChannelMessage.Read.All always needs an admin's consent, so a sign-in can leave channels out.
export const TEAMS_BASE_SCOPES = ['offline_access', 'User.Read'] as const
export const TEAMS_CHAT_SCOPES = ['Chat.Read', 'ChatMessage.Send'] as const
export const TEAMS_CHANNEL_SCOPES = [
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
  'ChannelMessage.Send'
] as const

export type TeamsScope = (typeof TEAMS_CHAT_SCOPES)[number] | (typeof TEAMS_CHANNEL_SCOPES)[number]

export function teamsSignInScopes(channels: boolean): string[] {
  return [...TEAMS_BASE_SCOPES, ...TEAMS_CHAT_SCOPES, ...(channels ? TEAMS_CHANNEL_SCOPES : [])]
}

/** Microsoft lists granted scopes bare or as Graph URLs, in any case. */
export function hasTeamsScope(granted: readonly string[], scope: TeamsScope): boolean {
  const wanted = scope.toLowerCase()
  return granted.some(
    (entry) => entry.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '') === wanted
  )
}
