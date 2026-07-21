import { execFile as execFileChildProcess, type ExecFileOptions } from 'node:child_process'
import type {
  DictationOutputCapabilities,
  DictationOutputControlSettings
} from '../../shared/dictation-output-settings'
import { clampDuckedVolumePercent } from '../../shared/dictation-output-settings'

export type DictationOutputControlExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => DictationOutputChildProcess

export type DictationOutputChildProcess = {
  kill: () => unknown
  once: (event: string, callback: () => void) => unknown
}

export type DictationOutputSnapshot = {
  supported: boolean
  platform: NodeJS.Platform
  outputMuted?: boolean
  outputVolumePercent?: number
  mediaPaused?: { music: boolean; spotify: boolean }
}

type DictationOutputControlServiceOptions = {
  platform?: NodeJS.Platform
  execFile?: DictationOutputControlExecFile
  commandTimeoutMs?: number
}

const MAC_OSASCRIPT = '/usr/bin/osascript'
const MAC_MUSIC_BUNDLE_ID = 'com.apple.Music'
const MAC_SPOTIFY_BUNDLE_ID = 'com.spotify.client'
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000
const NO_OP_CAPABILITIES: DictationOutputCapabilities = {
  canMuteOutput: false,
  canDuckOutput: false,
  canPauseMedia: false
}

const defaultExecFile: DictationOutputControlExecFile = (file, args, options, callback) =>
  execFileChildProcess(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
    callback(error, String(stdout), String(stderr))
  }) as DictationOutputChildProcess

export class DictationOutputControlService {
  readonly #platform: NodeJS.Platform
  readonly #execFile: DictationOutputControlExecFile
  readonly #commandTimeoutMs: number
  readonly #snapshots = new Map<string, DictationOutputSnapshot>()
  #capabilities: Promise<DictationOutputCapabilities> | null = null

  constructor(options: DictationOutputControlServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#execFile = options.execFile ?? defaultExecFile
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  }

  getCapabilities(): Promise<DictationOutputCapabilities> {
    if (!this.#isMacSupported()) {
      return Promise.resolve(NO_OP_CAPABILITIES)
    }
    this.#capabilities ??= this.#probeCapabilities()
    return this.#capabilities
  }

  async #probeCapabilities(): Promise<DictationOutputCapabilities> {
    const snapshot = await this.#captureMacSnapshot()
    if (!snapshot.supported) {
      return NO_OP_CAPABILITIES
    }
    return { canMuteOutput: true, canDuckOutput: true, canPauseMedia: true }
  }

  async applyForSession(
    sessionId: string,
    settings: DictationOutputControlSettings
  ): Promise<void> {
    if (this.#snapshots.has(sessionId) || !this.#isMacSupported()) {
      return
    }

    const snapshot = await this.#captureMacSnapshot()
    this.#snapshots.set(sessionId, snapshot)
    if (!snapshot.supported) {
      return
    }

    if (settings.volumeMode === 'mute') {
      await this.#runMacScript('set volume with output muted')
    } else if (settings.volumeMode === 'duck') {
      const duckedVolumePercent = clampDuckedVolumePercent(settings.duckedVolumePercent)
      await this.#runMacScript(`set volume output volume ${duckedVolumePercent}`)
    }

    if (settings.pauseMedia) {
      const music = await this.#probeAndPauseApp(MAC_MUSIC_BUNDLE_ID)
      const spotify = await this.#probeAndPauseApp(MAC_SPOTIFY_BUNDLE_ID)
      snapshot.mediaPaused = { music, spotify }
    }
  }

  async restoreForSession(sessionId: string): Promise<void> {
    const snapshot = this.#snapshots.get(sessionId)
    if (!snapshot) {
      return
    }
    this.#snapshots.delete(sessionId)
    await this.#restoreSnapshot(snapshot)
  }

  async restoreForOwner(ownerKey: string): Promise<void> {
    const ownedSessionPrefix = `${ownerKey}:`
    const ownedSnapshots = Array.from(this.#snapshots.entries()).filter(([sessionId]) =>
      sessionId.startsWith(ownedSessionPrefix)
    )
    for (const [sessionId] of ownedSnapshots) {
      this.#snapshots.delete(sessionId)
    }
    for (const [, snapshot] of ownedSnapshots.toReversed()) {
      await this.#restoreSnapshot(snapshot)
    }
  }

  async restoreAll(): Promise<void> {
    const snapshots = Array.from(this.#snapshots.values())
    this.#snapshots.clear()
    for (const snapshot of snapshots.toReversed()) {
      await this.#restoreSnapshot(snapshot)
    }
  }

  #isMacSupported(): boolean {
    return this.#platform === 'darwin'
  }

  async #captureMacSnapshot(): Promise<DictationOutputSnapshot> {
    try {
      const volume = Number.parseInt(
        (await this.#runMacScript('output volume of (get volume settings)')).trim(),
        10
      )
      if (!Number.isFinite(volume)) {
        return { supported: false, platform: this.#platform }
      }
      const mutedRaw = (await this.#runMacScript('output muted of (get volume settings)')).trim()
      if (mutedRaw !== 'true' && mutedRaw !== 'false') {
        return { supported: false, platform: this.#platform }
      }
      const muted = mutedRaw === 'true'
      return {
        supported: true,
        platform: this.#platform,
        outputVolumePercent: volume,
        outputMuted: muted
      }
    } catch (error) {
      console.warn('[dictation-output-control] failed to snapshot output state:', error)
      return { supported: false, platform: this.#platform }
    }
  }

  async #restoreSnapshot(snapshot: DictationOutputSnapshot): Promise<void> {
    if (!snapshot.supported || snapshot.platform !== 'darwin') {
      return
    }
    if (snapshot.outputVolumePercent !== undefined) {
      await this.#runMacScript(`set volume output volume ${snapshot.outputVolumePercent}`)
    }
    if (snapshot.outputMuted === true) {
      await this.#runMacScript('set volume with output muted')
    } else if (snapshot.outputMuted === false) {
      await this.#runMacScript('set volume without output muted')
    }
    if (snapshot.mediaPaused?.music === true) {
      await this.#runMacJxa(this.#playAppScript(MAC_MUSIC_BUNDLE_ID))
    }
    if (snapshot.mediaPaused?.spotify === true) {
      await this.#runMacJxa(this.#playAppScript(MAC_SPOTIFY_BUNDLE_ID))
    }
  }

  #probeAndPauseScript(bundleId: string): string {
    return `(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${bundleId}'); if (runningApps.count === 0) return ''; const a = Application('${bundleId}'); if (String(a.playerState()) !== 'playing') return ''; a.pause(); return 'paused'; })()`
  }

  async #probeAndPauseApp(bundleId: string): Promise<boolean> {
    const result = await this.#runMacJxa(this.#probeAndPauseScript(bundleId))
    return result.trim() === 'paused'
  }

  #playAppScript(bundleId: string): string {
    return `(() => { ObjC.import('AppKit'); const runningApps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${bundleId}'); if (runningApps.count === 0) return ''; const a = Application('${bundleId}'); if (String(a.playerState()) === 'playing') return ''; a.play(); return 'played'; })()`
  }

  #runMacScript(script: string): Promise<string> {
    return this.#runMacCommand(script, ['-e', script])
  }

  #runMacJxa(script: string): Promise<string> {
    return this.#runMacCommand(script, ['-l', 'JavaScript', '-e', script])
  }

  #runMacCommand(script: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve) => {
      let settled = false
      let child: DictationOutputChildProcess | null = null
      const settle = (value: string): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        console.warn('[dictation-output-control] command timed out:', script)
        child?.kill()
        settle('')
      }, this.#commandTimeoutMs)

      child = this.#execFile(
        MAC_OSASCRIPT,
        args,
        { timeout: this.#commandTimeoutMs },
        (error, stdout) => {
          if (error) {
            console.warn('[dictation-output-control] command failed:', error)
            settle('')
            return
          }
          settle(stdout)
        }
      )
    })
  }
}

export const dictationOutputControlService = new DictationOutputControlService()
