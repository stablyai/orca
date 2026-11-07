/** For reads with no viewerDidAuthor (GitHub REST, GitLab): the comment is the viewer's when its login is the reading account's. */
export function viewerAuthorship(
  login: string | null | undefined,
  viewerLogin: string | null
): { viewerDidAuthor?: true } {
  // GitHub logins and GitLab usernames are case-insensitive.
  return login && viewerLogin && login.toLowerCase() === viewerLogin.toLowerCase()
    ? { viewerDidAuthor: true }
    : {}
}
