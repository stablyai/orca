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
