import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

// Why: Devin ATIF transcripts live under <DEVIN_HOME>/transcripts; the cli
// data dir is %APPDATA%\devin\cli on Windows and $XDG_DATA_HOME/devin/cli
// (default ~/.local/share) on posix. Shared by the AI Vault session scanner
// and the Devin usage scanner so both read the same install.
export function resolveDevinCliDataDir(): string {
  // Why: a relative platform var (malformed env) would silently resolve
  // devin/cli under Orca's cwd — keep it only when absolute.
  const platformDataDir = resolveAbsoluteDirOverride(
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_DATA_HOME,
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.local', 'share')
  )
  return resolveAbsoluteDirOverride(process.env.DEVIN_HOME, join(platformDataDir, 'devin', 'cli'))
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}
