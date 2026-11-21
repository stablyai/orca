import { RuntimeClientError } from '../runtime/connection/types'

// Guides wrap platform-only text in these blocks so a session reads only the notes for its platform.
export const GUIDE_PLATFORMS = ['macos', 'linux', 'windows'] as const
export type GuidePlatform = (typeof GUIDE_PLATFORMS)[number]
export type GuidePlatformSelection = GuidePlatform | 'all'

const PLATFORM_BLOCK_START = /^<!-- platform: ([a-z ]+) -->$/
const PLATFORM_BLOCK_END = '<!-- /platform -->'

export function hasPlatformBlocks(markdown: string): boolean {
  return markdown.includes('<!-- platform: ')
}

function isGuidePlatform(value: string): value is GuidePlatform {
  return GUIDE_PLATFORMS.some((platform) => platform === value)
}

/** Returns the reasons a guide's platform blocks are malformed; the bundled-guide test requires none. */
export function platformBlockProblems(markdown: string): string[] {
  const problems: string[] = []
  let open: number | null = null
  const lines = markdown.split('\n')
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const start = PLATFORM_BLOCK_START.exec(line)
    if (start) {
      if (open !== null) {
        problems.push(
          `line ${lineNumber}: platform block opened inside the block from line ${open}`
        )
      }
      const names = start[1].split(' ')
      const unknown = names.filter((name) => !isGuidePlatform(name))
      if (unknown.length > 0 || names.length === 0) {
        problems.push(`line ${lineNumber}: unknown platform ${unknown.join(', ')}`)
      }
      open = lineNumber
    } else if (line === PLATFORM_BLOCK_END) {
      if (open === null) {
        problems.push(`line ${lineNumber}: platform block closed without being opened`)
      }
      open = null
    } else if (line.includes('<!-- platform') || line.includes('<!-- /platform')) {
      problems.push(`line ${lineNumber}: platform marker must be alone on its line`)
    }
  }
  if (open !== null) {
    problems.push(`line ${open}: platform block is never closed`)
  }
  return problems
}

/**
 * Keeps shared text plus the blocks for `platform`; 'all' keeps every block. Marker lines are
 * always dropped, and blank lines left next to a removed marker or block collapse into one so
 * paragraphs and lists keep their spacing.
 */
export function filterPlatformBlocks(markdown: string, platform: GuidePlatformSelection): string {
  if (!hasPlatformBlocks(markdown)) {
    return markdown
  }
  const output: string[] = []
  let dropping = false
  let removedSinceText = false
  for (const line of markdown.split('\n')) {
    const start = PLATFORM_BLOCK_START.exec(line)
    if (start) {
      dropping = platform !== 'all' && !start[1].split(' ').includes(platform)
      removedSinceText = true
      continue
    }
    if (line === PLATFORM_BLOCK_END) {
      dropping = false
      removedSinceText = true
      continue
    }
    if (dropping) {
      continue
    }
    if (line === '') {
      if (removedSinceText && (output.length === 0 || output.at(-1) === '')) {
        continue
      }
    } else {
      removedSinceText = false
    }
    output.push(line)
  }
  return output.join('\n')
}

function platformOfProcess(platform: NodeJS.Platform): GuidePlatform | null {
  if (platform === 'darwin') {
    return 'macos'
  }
  if (platform === 'win32') {
    return 'windows'
  }
  return platform === 'linux' ? 'linux' : null
}

/**
 * `--platform` wins. Otherwise the guide follows the machine this CLI runs on, which is where
 * `orca computer` acts. A paired remote runtime or WSL may act on another platform, so those get
 * every block rather than a guess.
 */
export function resolveGuidePlatform(
  flags: Map<string, string | boolean>,
  host: { platform: NodeJS.Platform; isRemote: boolean; env: NodeJS.ProcessEnv }
): GuidePlatformSelection {
  if (flags.has('platform')) {
    const requested = flags.get('platform')
    const value = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
    if (value === 'all' || isGuidePlatform(value)) {
      return value
    }
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --platform "${typeof requested === 'string' ? requested : ''}". Use one of: ${[...GUIDE_PLATFORMS, 'all'].join(', ')}`
    )
  }
  if (host.isRemote || host.env.WSL_DISTRO_NAME?.trim()) {
    return 'all'
  }
  return platformOfProcess(host.platform) ?? 'all'
}
