import { execFile } from 'node:child_process'
import { access, readdir, readFile, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

// The oauth2.js relative path inside a @google/gemini-cli-core package.
const OAUTH2_SUBPATH = path.join('dist', 'src', 'code_assist', 'oauth2.js')

async function resolveGeminiBinary(): Promise<string | null> {
  const binaryNames = ['agy', 'antigravity', 'gemini']
  for (const bin of binaryNames) {
    const [lookup, args] =
      process.platform === 'win32' ? ['where.exe', [bin]] : ['which', [bin]]
    try {
      const { stdout } = await execFileAsync(lookup, args, {
        encoding: 'utf-8',
        windowsHide: true
      })
      const fromPath = stdout.trim().split(/\r?\n/)[0]
      if (fromPath && (await fileExists(fromPath))) {
        return fromPath
      }
    } catch {
      // ignore which/where failure
    }
  }

  // Why: on macOS/Linux GUI apps, the PATH might not include the binary.
  // Checking common installation prefixes as fallbacks.
  if (process.platform !== 'win32') {
    const prefixes = ['/usr/local/bin', '/opt/homebrew/bin', path.join(homedir(), '.local', 'bin'), path.join(homedir(), 'bin')]
    for (const bin of binaryNames) {
      for (const prefix of prefixes) {
        const candidate = path.join(prefix, bin)
        if (await fileExists(candidate)) {
          return candidate
        }
      }
    }
  }

  return null
}

// Why: on all platforms the gemini binary may be a symlink (e.g. Homebrew's bin/
// symlinks into Cellar). We must resolve it before deriving sibling paths — otherwise
// dirname points to the symlink directory, not the real installation root.
async function resolveSymlink(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
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

// Why: these are the known stable layouts for every major Gemini CLI and Antigravity CLI install method.
// Checking explicit paths is fast and avoids walking the entire directory tree.
async function extractFromKnownPaths(
  realGeminiPath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const binDir = path.dirname(realGeminiPath)
  const baseDir = path.dirname(binDir)

  const packages = ['@google/antigravity-cli', '@google/gemini-cli', 'antigravity-cli', 'antigravity']
  const candidates: string[] = []

  for (const pkg of packages) {
    candidates.push(
      path.join(baseDir, 'libexec', 'lib', 'node_modules', pkg, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
      path.join(baseDir, 'lib', 'node_modules', pkg, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
      path.join(baseDir, 'share', pkg, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
      path.join(baseDir, 'node_modules', pkg, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
      path.join(baseDir, 'node_modules', pkg, OAUTH2_SUBPATH)
    )
  }

  // Common direct sibling layouts
  candidates.push(
    path.join(baseDir, '..', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(baseDir, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH)
  )

  for (const candidate of candidates) {
    const creds = await tryReadCredentials(path.normalize(candidate))
    if (creds) {
      return creds
    }
  }

  return null
}

// Why: newer Gemini/Antigravity CLI versions ship everything bundled into hash-named
// chunks with no oauth2.js source file. Scanning the bundle dir for the credential
// constants is the only reliable fallback for those installs.
async function extractFromBundleDir(
  geminiCliPackageRoot: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const bundleDirs = [
    path.join(geminiCliPackageRoot, 'bundle'),
    path.join(geminiCliPackageRoot, 'dist'),
    path.join(geminiCliPackageRoot, 'out')
  ]

  for (const bundleDir of bundleDirs) {
    if (!(await fileExists(bundleDir))) {
      continue
    }

    let entries: string[]
    try {
      entries = (await readdir(bundleDir)).filter((f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'))
    } catch {
      continue
    }

    for (const entry of entries) {
      const creds = await tryReadCredentials(path.join(bundleDir, entry))
      if (creds) {
        return creds
      }
    }
  }

  return null
}

// Resolves the CLI package root directory by walking up the directory
// tree from the real binary path, looking for package.json with recognized names,
// or global Node layouts.
async function findGeminiPackageRoot(realGeminiPath: string): Promise<string | null> {
  const MAX_ASCENTS = 8
  const validNames = new Set([
    '@google/antigravity-cli',
    '@google/gemini-cli',
    '@google/agy',
    'antigravity',
    'antigravity-cli',
    'gemini-cli'
  ])
  let current = path.dirname(realGeminiPath)

  for (let i = 0; i <= MAX_ASCENTS; i++) {
    const pkgJson = path.join(current, 'package.json')
    if (await fileExists(pkgJson)) {
      try {
        const raw = await readFile(pkgJson, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name && validNames.has(pkg.name)) {
          return current
        }
      } catch {
        // malformed package.json — keep walking
      }
    }

    // Global Node layout checks
    for (const pkgName of ['@google/antigravity-cli', '@google/gemini-cli', '@google/agy', 'antigravity']) {
      const globalPkg = path.join(current, 'lib', 'node_modules', pkgName, 'package.json')
      if (await fileExists(globalPkg)) {
        return path.join(current, 'lib', 'node_modules', pkgName)
      }

      const windowsGlobalPkg = path.join(current, 'node_modules', pkgName, 'package.json')
      if (await fileExists(windowsGlobalPkg)) {
        return path.join(current, 'node_modules', pkgName)
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

export async function extractOAuthClientCredentials(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  // Allow environment variable overrides
  const envClientId = process.env.ANTIGRAVITY_CLIENT_ID || process.env.GEMINI_CLIENT_ID
  const envClientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET || process.env.GEMINI_CLIENT_SECRET
  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret }
  }

  const geminiPath = await resolveGeminiBinary()
  if (!geminiPath) {
    return null
  }

  const realPath = await resolveSymlink(geminiPath)

  // 1. Known static paths (fast, covers most installs with source layout)
  const fromKnown = await extractFromKnownPaths(realPath)
  if (fromKnown) {
    return fromKnown
  }

  // 2. Walk up to find the package root, then try source layout + bundle dir
  const packageRoot = await findGeminiPackageRoot(realPath)
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
