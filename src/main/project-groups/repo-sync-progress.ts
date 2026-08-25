import type { RepoManagedSeedProgress } from './repo-managed-seed'

const ESCAPE = String.fromCharCode(27)

function stripAnsi(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ESCAPE || value[index + 1] !== '[') {
      output += value[index]
      continue
    }
    index += 2
    while (index < value.length) {
      const code = value.charCodeAt(index)
      if (code >= 64 && code <= 126) {
        break
      }
      index += 1
    }
  }
  return output
}

export function createRepoSyncProgressParser(
  onProgress?: (progress: RepoManagedSeedProgress) => void
): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer = `${buffer}${chunk}`.slice(-16_384)
    const normalized = stripAnsi(buffer)
    const matches = [
      ...normalized.matchAll(/(?:Checkout[^\r\n]*?\s)?\((\d+)\s*\/\s*(\d+)\)\s*([^\r\n]+)/gi)
    ]
    const latest = matches.at(-1)
    if (!latest) {
      return
    }
    const message = latest[3].replace(/^\s*[:|-]\s*/, '').trim()
    const path = message.includes(' @ ') ? message.slice(message.lastIndexOf(' @ ') + 3) : message
    onProgress?.({
      processedProjects: Number(latest[1]),
      totalProjects: Number(latest[2]),
      currentProject: path.trim()
    })
  }
}
