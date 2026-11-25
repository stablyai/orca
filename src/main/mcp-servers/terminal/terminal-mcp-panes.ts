// What each agent terminal got from the host's MCP server list, by PTY, kept on disk so a terminal
// that outlives an Orca restart (its relay token died with the old run) still counts as out of date.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import type { TerminalMcpPaneLaunch } from './terminal-mcp-launch'

const FILE = 'mcp-terminal-panes.json'
const MAX_PANES = 500

const PaneSchema = z.object({
  agent: z.string().max(64),
  workspaceKey: z.string().max(1024).nullable(),
  workspaceId: z.string().max(4096).nullable(),
  wsl: z.boolean(),
  wslDistro: z.string().max(256).nullable().optional(),
  fingerprint: z.string().max(128).nullable()
})
const FileSchema = z.object({ version: z.literal(1), panes: z.record(z.string(), PaneSchema) })

/** This run's records over the ones read from disk; written back in order, newest last. */
class TerminalMcpPanes {
  private readonly recorded = new Map<string, TerminalMcpPaneLaunch>()
  private loaded: Promise<Map<string, TerminalMcpPaneLaunch>> | null = null
  private writes: Promise<void> = Promise.resolve()

  private path(): string {
    return join(getAppEnvironment().getPath('userData'), FILE)
  }

  private load(): Promise<Map<string, TerminalMcpPaneLaunch>> {
    this.loaded ??= readFile(this.path(), 'utf8').then(
      (text) => {
        const parsed = FileSchema.safeParse(JSON.parse(text))
        return new Map(parsed.success ? Object.entries(parsed.data.panes) : [])
      },
      // Missing or unreadable: no terminal of an earlier run is known to be out of date.
      () => new Map()
    )
    return this.loaded
  }

  /** The newest `MAX_PANES`: a terminal that many launches ago has long ended. */
  async all(): Promise<Map<string, TerminalMcpPaneLaunch>> {
    const merged = new Map(await this.load().catch(() => new Map()))
    for (const [ptyId, pane] of this.recorded) {
      merged.delete(ptyId)
      merged.set(ptyId, pane)
    }
    return new Map([...merged].slice(-MAX_PANES))
  }

  record(ptyId: string, pane: TerminalMcpPaneLaunch): void {
    this.recorded.delete(ptyId)
    this.recorded.set(ptyId, pane)
    for (const oldest of this.recorded.keys()) {
      if (this.recorded.size <= MAX_PANES) {
        break
      }
      this.recorded.delete(oldest)
    }
    this.writes = this.writes
      .then(async () => {
        const panes = [...(await this.all())]
        await writePluginFileAtomically(
          this.path(),
          `${JSON.stringify({ version: 1, panes: Object.fromEntries(panes) })}\n`,
          { mode: 0o600 }
        )
      })
      .catch((error: unknown) => {
        console.warn('[mcp-servers] could not save which servers a terminal got', error)
      })
  }
}

export const terminalMcpPanes = new TerminalMcpPanes()

/** At spawn commit: a fresh launch the host list decided for is recorded; a reattach keeps its own. */
export function recordTerminalMcpPaneForSpawn(args: {
  ptyId: string | undefined
  isReattach: boolean
  pane: TerminalMcpPaneLaunch | null | undefined
}): void {
  if (args.ptyId && !args.isReattach && args.pane) {
    terminalMcpPanes.record(args.ptyId, args.pane)
  }
}
