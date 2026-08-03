// Recognizes which dev server is behind a listening port, from the command
// line the port scanner already collects for attribution.
//
// Why this classification runs in main and not the renderer: argv routinely
// carries secrets (`--api-key=…`, `--token=…`). Only the bounded label below
// crosses the IPC/RPC boundary, so raw command lines never reach renderer,
// web, or mobile clients.

import type { DevServerIdentity } from '../../shared/workspace-ports'

/** Stripped so `vite.js`, `next.cmd`, and `node.exe` all reduce to one token. */
const EXECUTABLE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts|exe|cmd|bat|ps1|sh)$/

type DevServerSignature = {
  id: string
  /** Product name. A proper noun — never localized. */
  label: string
  /** Matches when every token of any one clause is present. */
  clauses: readonly (readonly string[])[]
}

// Ordered most-specific first. A bare token is only used where it is
// unambiguous on its own (`vite` only appears as an executable name); anything
// that doubles as a common word is paired with a companion token.
const DEV_SERVER_SIGNATURES: readonly DevServerSignature[] = [
  // Next.js renames its process to `next-server (v15.0.0)` once booted.
  { id: 'next', label: 'Next.js', clauses: [['next-server'], ['next', 'dev'], ['next', 'start']] },
  { id: 'nuxt', label: 'Nuxt', clauses: [['nuxt'], ['nuxi']] },
  { id: 'astro', label: 'Astro', clauses: [['astro']] },
  { id: 'remix', label: 'Remix', clauses: [['remix']] },
  { id: 'sveltekit', label: 'SvelteKit', clauses: [['svelte-kit']] },
  { id: 'gatsby', label: 'Gatsby', clauses: [['gatsby']] },
  { id: 'docusaurus', label: 'Docusaurus', clauses: [['docusaurus']] },
  { id: 'angular', label: 'Angular', clauses: [['ng', 'serve']] },
  { id: 'react-scripts', label: 'Create React App', clauses: [['react-scripts']] },
  { id: 'storybook', label: 'Storybook', clauses: [['storybook'], ['start-storybook']] },
  { id: 'expo', label: 'Expo', clauses: [['expo']] },
  { id: 'metro', label: 'Metro', clauses: [['metro'], ['react-native', 'start']] },
  { id: 'webpack', label: 'webpack', clauses: [['webpack-dev-server'], ['webpack', 'serve']] },
  { id: 'parcel', label: 'Parcel', clauses: [['parcel']] },
  // Vite is checked after the frameworks that wrap it so the wrapper wins.
  { id: 'electron-vite', label: 'electron-vite', clauses: [['electron-vite']] },
  { id: 'vite', label: 'Vite', clauses: [['vite']] },

  {
    id: 'rails',
    label: 'Rails',
    clauses: [
      ['rails', 'server'],
      ['rails', 's']
    ]
  },
  // Reported as Puma, not Rails: Sinatra, Hanami, Roda and bare `bundle exec
  // puma` all boot the same server, and Rails renames its process to `puma …`.
  { id: 'puma', label: 'Puma', clauses: [['puma']] },
  { id: 'django', label: 'Django', clauses: [['runserver']] },
  { id: 'uvicorn', label: 'Uvicorn', clauses: [['uvicorn']] },
  { id: 'gunicorn', label: 'Gunicorn', clauses: [['gunicorn']] },
  { id: 'flask', label: 'Flask', clauses: [['flask', 'run']] },
  { id: 'laravel', label: 'Laravel', clauses: [['artisan', 'serve']] },
  { id: 'phoenix', label: 'Phoenix', clauses: [['phx.server']] },
  { id: 'air', label: 'Air', clauses: [['air']] },
  { id: 'hugo', label: 'Hugo', clauses: [['hugo']] },
  { id: 'jekyll', label: 'Jekyll', clauses: [['jekyll']] },

  { id: 'json-server', label: 'json-server', clauses: [['json-server']] },
  { id: 'http-server', label: 'http-server', clauses: [['http-server']] }
  // No bare `serve` entry: the token is too common as a script name, and the
  // package-script fallback already reports it as e.g. `pnpm serve`.
]

/** Package managers whose `dev`-style script is the only visible signal. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])
const PACKAGE_SCRIPTS = new Set(['dev', 'start', 'serve', 'develop', 'preview'])

export type DevServerSource = {
  processName?: string
  commandLine?: string
}

/**
 * Identify the dev server behind a listening process. Returns `undefined` when
 * nothing matches, so callers keep showing the raw process name.
 */
export function identifyDevServer(source: DevServerSource): DevServerIdentity | undefined {
  // Signatures read both fields, because a rewritten title such as
  // `next-server (v15.0.0)` is sometimes the only evidence left. The script
  // fallback reads argv alone: a process merely *named* `npm` next to an
  // unrelated `dev.js` would otherwise be reported as `npm dev`.
  const argumentTokens = tokenize(source.commandLine)
  const tokens = new Set([...argumentTokens, ...tokenize(source.processName)])
  if (tokens.size === 0) {
    return undefined
  }

  for (const signature of DEV_SERVER_SIGNATURES) {
    if (signature.clauses.some((clause) => clause.every((token) => tokens.has(token)))) {
      return { id: signature.id, label: signature.label }
    }
  }

  return identifyPackageScript(argumentTokens)
}

/**
 * Fall back to the package-manager script when the framework itself is not
 * visible in argv. Both halves of the label come from the allowlists above, so
 * the result stays bounded even though it reads like free text.
 */
function identifyPackageScript(tokens: Set<string>): DevServerIdentity | undefined {
  let manager: string | undefined
  let script: string | undefined
  for (const token of tokens) {
    if (!manager && PACKAGE_MANAGERS.has(token)) {
      manager = token
    } else if (!script && PACKAGE_SCRIPTS.has(token)) {
      script = token
    }
  }
  if (!manager || !script) {
    return undefined
  }
  return { id: `${manager}-script`, label: `${manager} ${script}` }
}

/**
 * Reduce a command line to comparable tokens: quote-aware argument split, then
 * the lowercased basename of each argument with any executable extension
 * removed. Taking the basename is what keeps a project directory named
 * `vite-playground` from being mistaken for Vite itself.
 */
function tokenize(field: string | undefined): Set<string> {
  const tokens = new Set<string>()
  // A process name is split like a command line: a rewritten title such as
  // `next-server (v15.0.0)` carries its own whitespace.
  for (const argument of splitArguments(field ?? '')) {
    const token = toToken(argument)
    if (token) {
      tokens.add(token)
    }
  }
  return tokens
}

function toToken(argument: string): string {
  const basename = argument.split(/[/\\]/).pop() ?? argument
  return basename.toLowerCase().replace(EXECUTABLE_EXTENSION, '')
}

/** Split on whitespace while keeping quoted Windows paths (`"C:\Program Files\…"`) intact. */
function splitArguments(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of commandLine) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) {
    args.push(current)
  }
  return args
}
