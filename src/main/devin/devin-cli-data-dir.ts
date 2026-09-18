import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

// Why: Devin ATIF transcripts live under <DEVIN_HOME>/transcripts; the cli
// data dir is %APPDATA%\devin\cli on Windows and $XDG_DATA_HOME/devin/cli
// (default ~/.local/share) on posix. Shared by the AI Vault session scanner
// and the Devin usage scanner so both read the same install.
export function resolveDevinCliDataDir(): string {
  return resolveAbsoluteDirOverride(
    process.env.DEVIN_HOME,
    process.platform === 'win32'
      ? join(process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'devin', 'cli')
      : join(
          process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
          'devin',
          'cli'
        )
  )
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}
