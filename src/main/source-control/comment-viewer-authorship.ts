export function viewerAuthorship(
  login: string | null | undefined,
  viewerLogin: string | null
): { viewerDidAuthor?: true } {
  // GitHub logins and GitLab usernames are case-insensitive.
  return login && viewerLogin && login.toLowerCase() === viewerLogin.toLowerCase()
    ? { viewerDidAuthor: true }
    : {}
}
