import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

// Why: the CLI keeps credentials.toml at <data>/devin/credentials.toml with its
// data dir in the cli/ sibling (docs.devin.ai/cli/enterprise/devin-auth), and
// DEVIN_HOME names that cli/ dir directly.
export function resolveDevinCliDataDir(): string {
  const platformDefault =
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'devin', 'cli')
      : join(
          process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
          'devin',
          'cli'
        )
  return resolveAbsoluteDirOverride(process.env.DEVIN_HOME, platformDefault)
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}
