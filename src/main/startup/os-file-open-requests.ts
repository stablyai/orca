import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

export function isMarkdownFilePath(candidate: string): boolean {
  return isAbsolute(candidate) && MARKDOWN_EXTENSIONS.has(extname(candidate).toLowerCase())
}

export function extractMarkdownPathsFromArgv(argv: readonly string[]): string[] {
  // Why: argv[0] is the executable; Electron also injects Chromium switches the OS never sent.
  return argv.slice(1).filter((entry) => !entry.startsWith('-') && isMarkdownFilePath(entry))
}

export type OsFileOpenRequestQueue = {
  enqueue(filePath: string): void
  drain(): string[]
  setDeliver(deliver: ((filePath: string) => void) | null): void
}

export function createOsFileOpenRequestQueue(): OsFileOpenRequestQueue {
  const pending: string[] = []
  let deliver: ((filePath: string) => void) | null = null

  return {
    enqueue(filePath) {
      if (!isMarkdownFilePath(filePath)) {
        return
      }
      if (deliver) {
        deliver(filePath)
        return
      }
      if (!pending.includes(filePath)) {
        pending.push(filePath)
      }
    },
    drain() {
      return pending.splice(0, pending.length)
    },
    setDeliver(next) {
      deliver = next
    }
  }
}

export async function filterExistingFiles(paths: readonly string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(async (candidate) => {
      try {
        return (await stat(candidate)).isFile() ? candidate : null
      } catch {
        return null
      }
    })
  )
  return results.filter((entry): entry is string => entry !== null)
}
