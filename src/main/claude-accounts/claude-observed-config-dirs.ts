import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isDirectory } from './claude-profile-homes'

const MAX_OBSERVED_CONFIG_DIRS = 32

/** Claude config folders Orca saw in use but the login shell does not name, e.g. a wrapper's CLAUDE_CONFIG_DIR. */
export class ClaudeObservedConfigDirs {
  private observed: string[] | undefined
  // WSL/remote paths name no folder here; skip re-statting them on every hook.
  private readonly missing = new Set<string>()

  constructor(
    private readonly filePath: string,
    private readonly getSettings: () => Pick<GlobalSettings, 'agentDefaultEnv'>
  ) {}

  /** Orca's Claude launch-environment setting first, then folders seen in hook transcript paths. */
  list(): string[] {
    this.observed ??= this.load()
    const fromSettings = resolveAbsoluteDirOverride(
      this.getSettings().agentDefaultEnv?.claude?.CLAUDE_CONFIG_DIR,
      ''
    )
    return fromSettings ? [fromSettings, ...this.observed] : this.observed
  }

  /** Claude writes `<config>/projects/<encoded-cwd>/<id>.jsonl`; other shapes are ignored. */
  observeTranscriptPath(transcriptPath: string): void {
    if (!isAbsolute(transcriptPath)) {
      return
    }
    const projectsDir = dirname(dirname(resolve(transcriptPath)))
    const configDir = dirname(projectsDir)
    this.observed ??= this.load()
    if (
      basename(projectsDir) !== 'projects' ||
      this.observed.includes(configDir) ||
      this.missing.has(configDir)
    ) {
      return
    }
    if (!isDirectory(projectsDir)) {
      // A hooked config folder exists locally even before Claude creates `projects`.
      if (!isDirectory(configDir)) {
        this.missing.add(configDir)
      }
      return
    }
    this.observed = [configDir, ...this.observed].slice(0, MAX_OBSERVED_CONFIG_DIRS)
    try {
      writeFileAtomically(this.filePath, JSON.stringify(this.observed), { mode: 0o600 })
    } catch (error) {
      console.warn('[claude-profile] Could not save observed Claude config folders:', error)
    }
  }

  private load(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return Array.isArray(parsed)
        ? parsed.filter((dir): dir is string => typeof dir === 'string' && isAbsolute(dir))
        : []
    } catch {
      return []
    }
  }
}
