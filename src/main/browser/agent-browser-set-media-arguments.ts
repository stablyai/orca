import { BrowserError } from './browser-error'

// Why: agent-browser's `set media` matches the bare tokens dark/light/reduced-motion
// anywhere in its args and silently ignores everything else, so map Orca's values here.
export function agentBrowserSetMediaArguments(
  colorScheme: unknown,
  reducedMotion: unknown
): string[] {
  const args = ['set', 'media']
  if (colorScheme === 'dark' || colorScheme === 'light') {
    args.push(colorScheme)
  } else if (colorScheme != null) {
    throw new BrowserError(
      'invalid_argument',
      `Unsupported --color-scheme: ${String(colorScheme)} (expected dark or light)`
    )
  }
  if (reducedMotion === 'reduce') {
    args.push('reduced-motion')
  } else if (reducedMotion != null && reducedMotion !== 'no-preference') {
    throw new BrowserError(
      'invalid_argument',
      `Unsupported --reduced-motion: ${String(reducedMotion)} (expected reduce or no-preference)`
    )
  }
  return args
}
