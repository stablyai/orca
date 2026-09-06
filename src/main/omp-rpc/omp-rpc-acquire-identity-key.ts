export function ompRpcAcquireIdentityKey(
  cwd: string,
  sessionFile: string,
  sessionFilePath: string
): string {
  return `${cwd}\u0000${sessionFile}\u0000${sessionFilePath}`
}
