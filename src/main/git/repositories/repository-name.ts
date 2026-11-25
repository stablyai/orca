import { basename } from 'node:path'
export function getRepoName(path: string): string {
  const name = basename(path)
  return name.endsWith('.git') ? name.slice(0, -4) : name
}
