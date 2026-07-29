import type { App } from 'electron'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
// Why: the test host's path flavor must not decide whether a Windows path counts as absolute.
const ABSOLUTE_PATH_PATTERN = /^(?:\/|\\\\|[A-Za-z]:[\\/])/

export function isMarkdownFilePath(candidate: string): boolean {
  return (
    ABSOLUTE_PATH_PATTERN.test(candidate) &&
    MARKDOWN_EXTENSIONS.has(extname(candidate).toLowerCase())
  )
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

export function registerOsFileOpenRequests(options: {
  app: Pick<App, 'on'>
  queue: OsFileOpenRequestQueue
  platform: NodeJS.Platform
  argv: readonly string[]
}): void {
  const { app, argv, platform, queue } = options
  if (platform === 'darwin') {
    // Why: macOS delivers open-file before app.ready, so this must run at module load — not inside whenReady.
    app.on('open-file', (event, filePath) => {
      event.preventDefault()
      queue.enqueue(filePath)
    })
    return
  }
  for (const filePath of extractMarkdownPathsFromArgv(argv)) {
    queue.enqueue(filePath)
  }
}
