import { existsSync, readFileSync, readdirSync, watch } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import type { FSWatcher } from 'fs'

// Why: terminal-started `serve-sim --detach` writes state under $TMPDIR/serve-sim/ and may
// print JSON to the PTY. Orca-managed attach (CLI/pane) already registers via EmulatorBridge;
// this watcher only reacts to *external* helper starts so the UI can open a simulator tab
// without focus-steal (mirror advertised-url-watcher PTY binding model).

export type ServeSimHelperInfo = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  helperPid?: number
}

export type ServeSimStateDetectedEvent = {
  worktreeId: string
  info: ServeSimHelperInfo
  source: 'pty' | 'state-file'
}

const DEFAULT_STATE_DIR = join(tmpdir(), 'serve-sim')
const STATE_FILE_RE = /^server-([0-9A-F-]{36})\.json$/i
const PTY_JSON_RE = /\{[^{}]*"streamUrl"\s*:\s*"[^"]+"[^{}]*"wsUrl"\s*:\s*"[^"]+"[^{}]*\}/g

function parseHelperInfo(raw: unknown, fallbackUdid?: string): ServeSimHelperInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  const deviceUdid =
    (typeof obj.device === 'string' && obj.device) ||
    (typeof obj.deviceUdid === 'string' && obj.deviceUdid) ||
    fallbackUdid
  const streamUrl =
    (typeof obj.streamUrl === 'string' && obj.streamUrl) || (typeof obj.url === 'string' && obj.url)
  const wsUrl = typeof obj.wsUrl === 'string' ? obj.wsUrl : undefined
  if (!deviceUdid || !streamUrl || !wsUrl) {
    return null
  }
  return {
    deviceUdid,
    wsUrl,
    streamUrl,
    axUrl: typeof obj.axUrl === 'string' ? obj.axUrl : undefined,
    helperPid: typeof obj.pid === 'number' ? obj.pid : undefined
  }
}

function readStateFilePath(filePath: string): ServeSimHelperInfo | null {
  try {
    const name = basename(filePath)
    const match = STATE_FILE_RE.exec(name)
    const fallbackUdid = match?.[1]
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return parseHelperInfo(raw, fallbackUdid)
  } catch {
    return null
  }
}

function helperInstanceKey(info: ServeSimHelperInfo): string {
  return `${info.deviceUdid}::${info.helperPid ?? 'pidless'}::${info.wsUrl}::${info.streamUrl}`
}

export class ServeSimStateWatcher {
  private readonly stateDir: string
  private readonly parentDir: string
  private readonly ptyToWorktree = new Map<string, string>()
  private readonly ptyBuffers = new Map<string, string>()
  private readonly seenExternalKeys = new Set<string>()
  private readonly orcaManagedHelperKeys = new Set<string>()
  private readonly listeners = new Set<(event: ServeSimStateDetectedEvent) => void>()
  private parentWatcher: FSWatcher | null = null
  private stateWatcher: FSWatcher | null = null
  private stateDirPoll: ReturnType<typeof setInterval> | null = null

  constructor(options: { stateDir?: string; parentDir?: string } = {}) {
    this.stateDir = options.stateDir ?? DEFAULT_STATE_DIR
    this.parentDir = options.parentDir ?? tmpdir()
  }

  onDetected(listener: (event: ServeSimStateDetectedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Why: bridge calls this when Orca CLI/pane attaches so we do not duplicate-tab on our own session.
  markOrcaManaged(info: ServeSimHelperInfo): void {
    this.orcaManagedHelperKeys.add(helperInstanceKey(info))
  }

  unmarkOrcaManaged(deviceUdid: string): void {
    for (const key of this.orcaManagedHelperKeys) {
      if (key.startsWith(`${deviceUdid}::`)) {
        this.orcaManagedHelperKeys.delete(key)
      }
    }
  }

  bindPty(ptyId: string, worktreeId: string): void {
    this.ptyToWorktree.set(ptyId, worktreeId)
    this.scanExistingStateFiles()
  }

  unbindPty(ptyId: string): void {
    this.ptyToWorktree.delete(ptyId)
    this.ptyBuffers.delete(ptyId)
  }

  forgetWorktree(worktreeId: string): void {
    for (const [ptyId, wt] of this.ptyToWorktree.entries()) {
      if (wt === worktreeId) {
        this.ptyToWorktree.delete(ptyId)
        this.ptyBuffers.delete(ptyId)
      }
    }
  }

  ingestPtyOutput(ptyId: string, data: string): void {
    const worktreeId = this.ptyToWorktree.get(ptyId)
    if (!worktreeId) {
      return
    }

    const prev = this.ptyBuffers.get(ptyId) ?? ''
    const combined = (prev + data).slice(-16_384)
    this.ptyBuffers.set(ptyId, combined)

    const matches = combined.match(PTY_JSON_RE)
    if (!matches) {
      return
    }
    for (const fragment of matches) {
      try {
        const info = parseHelperInfo(JSON.parse(fragment))
        if (info) {
          this.emitIfExternal(worktreeId, info, 'pty')
        }
      } catch {
        /* ignore partial JSON */
      }
    }
  }

  start(): void {
    if (this.parentWatcher || this.stateWatcher) {
      return
    }
    try {
      // Why: $TMPDIR/serve-sim/ may not exist until the first terminal `serve-sim --detach`.
      // Watch the parent tmpdir and attach to serve-sim/ when it appears (or watch it directly if present).
      this.attachStateDirWatch()
      if (this.stateWatcher) {
        this.scanExistingStateFiles()
        return
      }

      this.parentWatcher = watch(this.parentDir, (_event, filename) => {
        if (!filename || String(filename) !== 'serve-sim') {
          return
        }
        this.attachStateDirWatch()
        this.scanExistingStateFiles()
      })
      this.stateDirPoll = setInterval(() => {
        this.attachStateDirWatch()
        this.scanExistingStateFiles()
      }, 250)
      this.stateDirPoll.unref?.()
    } catch {
      // Non-mac or permission issues: watcher is best-effort.
    }
  }

  stop(): void {
    this.parentWatcher?.close()
    this.stateWatcher?.close()
    if (this.stateDirPoll) {
      clearInterval(this.stateDirPoll)
    }
    this.parentWatcher = null
    this.stateWatcher = null
    this.stateDirPoll = null
    this.ptyToWorktree.clear()
    this.ptyBuffers.clear()
    this.seenExternalKeys.clear()
    this.orcaManagedHelperKeys.clear()
    this.listeners.clear()
  }

  private attachStateDirWatch(): void {
    if (this.stateWatcher || !existsSync(this.stateDir)) {
      return
    }
    this.stateWatcher = watch(this.stateDir, (_event, filename) => {
      if (!filename) {
        return
      }
      const name = String(filename)
      if (!STATE_FILE_RE.test(name)) {
        return
      }
      const info = readStateFilePath(join(this.stateDir, name))
      if (!info) {
        return
      }
      const worktreeId = this.latestBoundWorktree()
      if (worktreeId) {
        this.emitIfExternal(worktreeId, info, 'state-file')
      }
    })
    if (this.stateDirPoll) {
      clearInterval(this.stateDirPoll)
      this.stateDirPoll = null
    }
  }

  private latestBoundWorktree(): string | undefined {
    let latest: string | undefined
    for (const wt of this.ptyToWorktree.values()) {
      latest = wt
    }
    return latest
  }

  private scanExistingStateFiles(): void {
    const worktreeId = this.latestBoundWorktree()
    if (!worktreeId || !existsSync(this.stateDir)) {
      return
    }
    try {
      for (const name of readdirSync(this.stateDir)) {
        if (!STATE_FILE_RE.test(name)) {
          continue
        }
        const info = readStateFilePath(join(this.stateDir, name))
        if (info) {
          this.emitIfExternal(worktreeId, info, 'state-file')
        }
      }
    } catch {
      /* ignore */
    }
  }

  private emitIfExternal(
    worktreeId: string,
    info: ServeSimHelperInfo,
    source: ServeSimStateDetectedEvent['source']
  ): void {
    const instanceKey = helperInstanceKey(info)
    if (this.orcaManagedHelperKeys.has(instanceKey)) {
      return
    }
    const dedupeKey = `${worktreeId}::${instanceKey}`
    if (this.seenExternalKeys.has(dedupeKey)) {
      return
    }
    this.seenExternalKeys.add(dedupeKey)
    const event: ServeSimStateDetectedEvent = { worktreeId, info, source }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* listener errors must not break watcher */
      }
    }
  }
}

export const serveSimStateWatcher = new ServeSimStateWatcher()
