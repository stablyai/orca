import { homedir } from 'node:os'
import { join } from 'node:path'

const POSIX_DEVIN_TRANSCRIPTS_SEGMENTS = ['.local', 'share', 'devin', 'cli', 'transcripts'] as const
const WINDOWS_DEVIN_TRANSCRIPTS_SEGMENTS = [
  'AppData',
  'Roaming',
  'devin',
  'cli',
  'transcripts'
] as const

// Why: WSL distro homes are Linux even when the Orca host is Windows, so extra
// WSL roots always use the POSIX layout. Remote Windows uses the win32 segments.
export function defaultDevinTranscriptsSegments(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? WINDOWS_DEVIN_TRANSCRIPTS_SEGMENTS
    : POSIX_DEVIN_TRANSCRIPTS_SEGMENTS
}

export function resolveDevinTranscriptsDir(
  args: {
    override?: string
    env?: NodeJS.ProcessEnv
    homeDir?: string
    platform?: NodeJS.Platform
  } = {}
): string {
  if (args.override !== undefined) {
    return args.override
  }
  const env = args.env ?? process.env
  const homeDir = args.homeDir ?? homedir()
  const platform = args.platform ?? process.platform
  const fromEnv = env.DEVIN_HOME?.trim()
  if (fromEnv) {
    return join(fromEnv, 'transcripts')
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(homeDir, 'AppData', 'Roaming')
    return join(appData, 'devin', 'cli', 'transcripts')
  }
  return join(homeDir, ...POSIX_DEVIN_TRANSCRIPTS_SEGMENTS)
}
