// GitLab REST project paths require encoded slashes.
export function encodedProject(projectPath: string): string {
  return encodeURIComponent(projectPath)
}
