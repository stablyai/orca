import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'

const API_TIMEOUT_MS = 10_000
const OAUTH_CREDS_PATH = path.join(homedir(), '.gemini', 'oauth_creds.json')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

export type GeminiCredentials = {
  access_token: string
  refresh_token: string
  expiry_date: number
}

export type GoogleAuthEntry = {
  type: 'oauth'
  access: string
  expires: number
  refresh: string
}

type AuthJson = {
  google?: GoogleAuthEntry
  'opencode-go'?: { type: 'api'; key: string }
}

export async function readAuthJson(): Promise<AuthJson | null> {
  const candidates = [
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
      : null,
    path.join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    path.join(homedir(), 'Library', 'Application Support', 'opencode', 'auth.json')
  ].filter((candidate): candidate is string => candidate !== null)

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf-8')
      return JSON.parse(raw) as AuthJson
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        continue
      }
      throw err
    }
  }

  return null
}

export async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
  try {
    const raw = await readFile(OAUTH_CREDS_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'access_token' in parsed &&
      typeof parsed.access_token === 'string' &&
      'refresh_token' in parsed &&
      typeof parsed.refresh_token === 'string' &&
      'expiry_date' in parsed &&
      typeof parsed.expiry_date === 'number'
    ) {
      return parsed as GeminiCredentials
    }
    return null
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

function resolveGeminiBinary(): string | null {
  const whichCmd = process.platform === 'win32' ? 'where gemini' : 'which gemini'
  try {
    return execSync(whichCmd, { encoding: 'utf-8' }).trim().split('\n')[0] ?? null
  } catch {
    return null
  }
}

// Why: on all platforms the gemini binary may be a symlink (e.g. Homebrew's bin/
// symlinks into Cellar). We must resolve it before deriving sibling paths — otherwise
// dirname points to the symlink directory, not the real installation root.
function resolveSymlink(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return filePath
  }
}

function parseOAuthCredentials(content: string): { clientId: string; clientSecret: string } | null {
  const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1]
  const secretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1]
  if (idMatch && secretMatch) {
    return { clientId: idMatch, clientSecret: secretMatch }
  }
  return null
}

async function tryReadCredentials(
  filePath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return parseOAuthCredentials(content)
  } catch {
    return null
  }
}

// The oauth2.js relative path inside a @google/gemini-cli-core package.
const OAUTH2_SUBPATH = path.join('dist', 'src', 'code_assist', 'oauth2.js')

// Why: these are the known stable layouts for every major Gemini CLI install method.
// Checking explicit paths is fast and avoids walking the entire directory tree.
async function extractFromKnownPaths(
  realGeminiPath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const binDir = path.dirname(realGeminiPath)
  const baseDir = path.dirname(binDir)

  const candidates = [
    // Homebrew: bin -> Cellar/<ver>/bin, real files live under libexec/lib
    path.join(
      baseDir,
      'libexec',
      'lib',
      'node_modules',
      '@google',
      'gemini-cli',
      'node_modules',
      '@google',
      'gemini-cli-core',
      OAUTH2_SUBPATH
    ),
    // Homebrew alternate (some versions skip the extra nesting)
    path.join(
      baseDir,
      'lib',
      'node_modules',
      '@google',
      'gemini-cli',
      'node_modules',
      '@google',
      'gemini-cli-core',
      OAUTH2_SUBPATH
    ),
    // Nix package layout
    path.join(
      baseDir,
      'share',
      'gemini-cli',
      'node_modules',
      '@google',
      'gemini-cli-core',
      OAUTH2_SUBPATH
    ),
    // npm/bun global install: gemini-cli-core is a sibling of gemini-cli
    path.join(baseDir, '..', 'gemini-cli-core', OAUTH2_SUBPATH),
    // npm nested inside gemini-cli
    path.join(baseDir, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH)
  ]

  for (const candidate of candidates) {
    const creds = await tryReadCredentials(path.normalize(candidate))
    if (creds) {
      return creds
    }
  }

  return null
}

// Why: newer Gemini CLI versions (>=0.38) ship everything bundled into hash-named
// chunks with no oauth2.js source file. Scanning the bundle dir for the credential
// constants is the only reliable fallback for those installs.
async function extractFromBundleDir(
  geminiCliPackageRoot: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const bundleDir = path.join(geminiCliPackageRoot, 'bundle')
  if (!existsSync(bundleDir)) {
    return null
  }

  let entries: string[]
  try {
    entries = readdirSync(bundleDir).filter((f) => f.endsWith('.js'))
  } catch {
    return null
  }

  for (const entry of entries) {
    const creds = await tryReadCredentials(path.join(bundleDir, entry))
    if (creds) {
      return creds
    }
  }

  return null
}

// Resolves the gemini-cli package root directory by walking up the directory
// tree from the real binary path, looking for package.json with the right name,
// or the global Node layout under lib/node_modules.
function findGeminiPackageRoot(realGeminiPath: string): string | null {
  const MAX_ASCENTS = 8
  let current = path.dirname(realGeminiPath)

  for (let i = 0; i <= MAX_ASCENTS; i++) {
    const pkgJson = path.join(current, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        const raw = readFileSync(pkgJson, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name === '@google/gemini-cli') {
          return current
        }
      } catch {
        // malformed package.json — keep walking
      }
    }

    // Global Node layout: <current>/lib/node_modules/@google/gemini-cli
    const globalPkg = path.join(
      current,
      'lib',
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json'
    )
    if (existsSync(globalPkg)) {
      return path.join(current, 'lib', 'node_modules', '@google', 'gemini-cli')
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

async function extractOAuthClientCredentials(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  const geminiPath = resolveGeminiBinary()
  if (!geminiPath) {
    return null
  }

  const realPath = resolveSymlink(geminiPath)

  // 1. Known static paths (fast, covers most installs with source layout)
  const fromKnown = await extractFromKnownPaths(realPath)
  if (fromKnown) {
    return fromKnown
  }

  // 2. Walk up to find the package root, then try source layout + bundle dir
  const packageRoot = findGeminiPackageRoot(realPath)
  if (packageRoot) {
    const fromSource =
      (await tryReadCredentials(
        path.join(packageRoot, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH)
      )) ?? (await tryReadCredentials(path.join(packageRoot, OAUTH2_SUBPATH)))
    if (fromSource) {
      return fromSource
    }

    const fromBundle = await extractFromBundleDir(packageRoot)
    if (fromBundle) {
      return fromBundle
    }
  }

  return null
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      signal: controller.signal
    })

    if (!res.ok) {
      return null
    }

    const data = (await res.json()) as { access_token?: string }
    return typeof data.access_token === 'string' ? data.access_token : null
  } finally {
    clearTimeout(timeout)
  }
}

export async function loadProjectId(accessToken: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    const res = await net.fetch(LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
      signal: controller.signal
    })

    if (!res.ok) {
      return ''
    }

    const data = (await res.json()) as { cloudaicompanionProject?: string }
    return typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : ''
  } finally {
    clearTimeout(timeout)
  }
}

// Why: accepts a plain refresh token string so both the oauth_creds.json path
// (GeminiCredentials) and the auth.json path (pipe-split string) can share
// the same bundle credential extraction without coupling to either struct.
export async function tryRefreshTokenFromBundle(refreshToken: string): Promise<string | null> {
  const clientCreds = await extractOAuthClientCredentials()
  if (!clientCreds) {
    return null
  }

  return refreshAccessToken(refreshToken, clientCreds.clientId, clientCreds.clientSecret)
}
