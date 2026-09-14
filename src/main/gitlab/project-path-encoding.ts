// Why: GitLab REST API addresses projects by URL-encoded path. Centralize
// the encoding so a future call site can't forget it (the slash escapes
// are easy to miss).
export function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}
