import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

// Why: Devin ATIF transcripts live under <DEVIN_HOME>/cli/transcripts;
// DEVIN_HOME overrides the devin root (%APPDATA%\devin on Windows,
// $XDG_DATA_HOME/devin on posix, default ~/.local/share), which also holds
// credentials.toml. Shared by the AI Vault session scanner and the Devin
// usage scanner so both read the same install.
export function resolveDevinCliDataDir(): string {
  // Why: a relative platform var (malformed env) would silently resolve
  // devin/cli under Orca's cwd — keep it only when absolute.
  const platformDataDir = resolveAbsoluteDirOverride(
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_DATA_HOME,
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.local', 'share')
  )
  return join(
    resolveAbsoluteDirOverride(process.env.DEVIN_HOME, join(platformDataDir, 'devin')),
    'cli'
  )
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}

// Why: the CLI keeps binaries/caches (cached_version.json, user_status.*.bin)
// separate from its data dir — %LOCALAPPDATA%\devin\cli on Windows,
// $XDG_CACHE_HOME/devin/cli (default ~/.cache) on posix.
function resolveDevinCliCacheDir(): string {
  const cacheRoot = resolveAbsoluteDirOverride(
    process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME,
    process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.cache')
  )
  return join(cacheRoot, 'devin', 'cli')
}

// Why: the CLI writes cached_version.json ({latest: "3000.x.y"}) under its
// cache dir; callers presenting the CLI's identity upstream should echo the
// installed version rather than a hardcoded one. Returns null when unreadable.
export function resolveDevinCliVersion(): string | null {
  for (const dir of [resolveDevinCliCacheDir(), resolveDevinCliDataDir()]) {
    try {
      const path = join(dir, 'cached_version.json')
      if (!existsSync(path)) {
        continue
      }
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      const latest =
        typeof parsed === 'object' && parsed !== null && 'latest' in parsed ? parsed.latest : null
      if (typeof latest === 'string' && latest.length > 0) {
        return latest
      }
    } catch {
      continue
    }
  }
  return null
}
