import { runProcess } from '@orca/process-host'
import { access, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

async function fileExists(filePath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted()
    await access(filePath)
    signal?.throwIfAborted()
    return true
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

// The oauth2.js relative path inside a @google/gemini-cli-core package.
const OAUTH2_SUBPATH = path.join('dist', 'src', 'code_assist', 'oauth2.js')

async function resolveGeminiBinary(signal?: AbortSignal): Promise<string | null> {
  const [lookup, args] =
    process.platform === 'win32' ? ['where.exe', ['gemini']] : ['which', ['gemini']]
  try {
    signal?.throwIfAborted()
    const { stdout, code } = await runProcess({ program: lookup, args, signal })
    signal?.throwIfAborted()
    if (code !== 0) {
      throw new Error('Gemini binary lookup failed')
    }
    const fromPath = stdout.trim().split(/\r?\n/)[0]
    if (fromPath && (await fileExists(fromPath, signal))) {
      return fromPath
    }
  } catch {
    signal?.throwIfAborted()
    // ignore which/where failure
  }

  // Why: on macOS/Linux GUI apps, the PATH might not include the binary.
  // Checking common installation prefixes as fallbacks.
  if (process.platform !== 'win32') {
    const fallbacks = [
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      path.join(homedir(), '.local', 'bin', 'gemini'),
      path.join(homedir(), 'bin', 'gemini')
    ]
    for (const candidate of fallbacks) {
      if (await fileExists(candidate, signal)) {
        return candidate
      }
    }
  }

  return null
}

// Why: on all platforms the gemini binary may be a symlink (e.g. Homebrew's bin/
// symlinks into Cellar). We must resolve it before deriving sibling paths — otherwise
// dirname points to the symlink directory, not the real installation root.
async function resolveSymlink(filePath: string, signal?: AbortSignal): Promise<string> {
  try {
    signal?.throwIfAborted()
    const resolved = await realpath(filePath)
    signal?.throwIfAborted()
    return resolved
  } catch {
    signal?.throwIfAborted()
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
  filePath: string,
  signal?: AbortSignal
): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    signal?.throwIfAborted()
    const content = await readFile(filePath, 'utf-8')
    signal?.throwIfAborted()
    return parseOAuthCredentials(content)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

// Why: these are the known stable layouts for every major Gemini CLI install method.
// Checking explicit paths is fast and avoids walking the entire directory tree.
async function extractFromKnownPaths(
  realGeminiPath: string,
  signal?: AbortSignal
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
    const creds = await tryReadCredentials(path.normalize(candidate), signal)
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
  geminiCliPackageRoot: string,
  signal?: AbortSignal
): Promise<{ clientId: string; clientSecret: string } | null> {
  const bundleDir = path.join(geminiCliPackageRoot, 'bundle')
  if (!(await fileExists(bundleDir, signal))) {
    return null
  }

  let entries: string[]
  try {
    signal?.throwIfAborted()
    entries = (await readdir(bundleDir)).filter((f) => f.endsWith('.js'))
  } catch {
    signal?.throwIfAborted()
    return null
  }

  signal?.throwIfAborted()
  for (const entry of entries) {
    const creds = await tryReadCredentials(path.join(bundleDir, entry), signal)
    if (creds) {
      return creds
    }
  }

  return null
}

// Resolves the gemini-cli package root directory by walking up the directory
// tree from the real binary path, looking for package.json with the right name,
// or the global Node layout under lib/node_modules.
async function findGeminiPackageRoot(
  realGeminiPath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const MAX_ASCENTS = 8
  let current = path.dirname(realGeminiPath)

  for (let i = 0; i <= MAX_ASCENTS; i++) {
    const pkgJson = path.join(current, 'package.json')
    if (await fileExists(pkgJson, signal)) {
      try {
        signal?.throwIfAborted()
        const raw = await readFile(pkgJson, 'utf-8')
        signal?.throwIfAborted()
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name === '@google/gemini-cli') {
          return current
        }
      } catch {
        signal?.throwIfAborted()
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
    if (await fileExists(globalPkg, signal)) {
      return path.join(current, 'lib', 'node_modules', '@google', 'gemini-cli')
    }

    // Windows global install layout: <current>/node_modules/@google/gemini-cli
    const windowsGlobalPkg = path.join(
      current,
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json'
    )
    if (await fileExists(windowsGlobalPkg, signal)) {
      return path.join(current, 'node_modules', '@google', 'gemini-cli')
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

export async function extractOAuthClientCredentials(signal?: AbortSignal): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  signal?.throwIfAborted()
  const geminiPath = await resolveGeminiBinary(signal)
  if (!geminiPath) {
    return null
  }

  const realPath = await resolveSymlink(geminiPath, signal)

  // 1. Known static paths (fast, covers most installs with source layout)
  const fromKnown = await extractFromKnownPaths(realPath, signal)
  if (fromKnown) {
    return fromKnown
  }

  // 2. Walk up to find the package root, then try source layout + bundle dir
  const packageRoot = await findGeminiPackageRoot(realPath, signal)
  if (packageRoot) {
    const fromSource =
      (await tryReadCredentials(
        path.join(packageRoot, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
        signal
      )) ?? (await tryReadCredentials(path.join(packageRoot, OAUTH2_SUBPATH), signal))
    if (fromSource) {
      return fromSource
    }

    const fromBundle = await extractFromBundleDir(packageRoot, signal)
    if (fromBundle) {
      return fromBundle
    }
  }

  return null
}
