import { join } from 'path'
import { readFileSync, existsSync, readdirSync } from 'fs'
import type { SessionMeta } from './history-manager'
import { getHistorySessionDirName } from './history-paths'

export type ColdRestoreInfo = {
  scrollback: string
  cwd: string
  cols: number
  rows: number
}

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

export class HistoryReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  detectColdRestore(sessionId: string): ColdRestoreInfo | null {
    const meta = this.readMeta(sessionId)
    if (!meta) {
      return null
    }
    if (meta.endedAt !== null) {
      return null
    }

    const scrollback = this.readScrollback(sessionId)
    return {
      scrollback: this.truncateAltScreen(scrollback),
      cwd: meta.cwd,
      cols: meta.cols,
      rows: meta.rows
    }
  }

  listRestorable(): string[] {
    if (!existsSync(this.basePath)) {
      return []
    }

    let entries: { isDirectory(): boolean; name: string }[]
    try {
      entries = readdirSync(this.basePath, { withFileTypes: true })
    } catch {
      return []
    }
    const restorable: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const sessionId = decodeURIComponent(entry.name)
      const meta = this.readMeta(sessionId)
      if (meta && meta.endedAt === null) {
        restorable.push(sessionId)
      }
    }

    return restorable
  }

  private readMeta(sessionId: string): SessionMeta | null {
    const metaPath = join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json')
    if (!existsSync(metaPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      return null
    }
  }

  private readScrollback(sessionId: string): string {
    const scrollbackPath = join(
      this.basePath,
      getHistorySessionDirName(sessionId),
      'scrollback.bin'
    )
    if (!existsSync(scrollbackPath)) {
      return ''
    }
    try {
      return readFileSync(scrollbackPath, 'utf-8')
    } catch {
      return ''
    }
  }

  // Why: raw scrollback from TUI sessions (vim, less, htop) contains
  // alternate-screen switches that produce garbled output when replayed.
  // Truncate before the outermost unmatched alt-screen-on so only normal
  // terminal output is restored.
  private truncateAltScreen(data: string): string {
    let depth = 0
    let outermostUnmatchedOnIdx = -1

    let searchFrom = 0
    while (searchFrom < data.length) {
      const onIdx = data.indexOf(ALT_SCREEN_ON, searchFrom)
      const offIdx = data.indexOf(ALT_SCREEN_OFF, searchFrom)

      if (onIdx === -1 && offIdx === -1) {
        break
      }

      if (onIdx !== -1 && (offIdx === -1 || onIdx < offIdx)) {
        // Why: track where depth first goes above 0 — that's the outermost
        // unmatched ON. Nested ONs (depth > 1) are inside the same alt-screen
        // block, so we truncate at the outermost boundary.
        if (depth === 0) {
          outermostUnmatchedOnIdx = onIdx
        }
        depth++
        searchFrom = onIdx + ALT_SCREEN_ON.length
      } else {
        if (depth > 0) {
          depth--
        }
        searchFrom = offIdx + ALT_SCREEN_OFF.length
      }
    }

    if (depth > 0 && outermostUnmatchedOnIdx !== -1) {
      return data.slice(0, outermostUnmatchedOnIdx)
    }

    return data
  }
}
