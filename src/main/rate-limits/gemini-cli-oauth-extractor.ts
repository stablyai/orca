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

const OAUTH2_SUBPATH = path.join('dist', 'src', 'code_assist', 'oauth2.js')

async function resolveGeminiBinary(): Promise<string | null> {
  const [lookup, args] =
    process.platform === 'win32' ? ['where.exe', ['gemini']] : ['which', ['gemini']]
  try {
    // Shell execution defeats Windows console hiding; use execFile (#14543, #10488).
    const { stdout } = await execFileAsync(lookup, args, {
      encoding: 'utf-8',
      windowsHide: true
    })
    const fromPath = stdout.trim().split(/\r?\n/)[0]
    if (fromPath && (await fileExists(fromPath))) {
      return fromPath
    }
  } catch {
    // Fall through to known install prefixes when lookup fails.
  }

  // GUI PATH may omit common macOS/Linux install prefixes.
  if (process.platform !== 'win32') {
    const fallbacks = [
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      path.join(homedir(), '.local', 'bin', 'gemini'),
      path.join(homedir(), 'bin', 'gemini')
    ]
    for (const candidate of fallbacks) {
      if (await fileExists(candidate)) {
        return candidate
      }
    }
  }

  return null
}

// Resolve symlinks before deriving package siblings (e.g. Homebrew Cellar installs).
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

// Probe known install layouts without recursively walking the filesystem.
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
    // Alternate Homebrew layout without extra nesting.
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

// Gemini >=0.38 can bundle oauth2.js into hashed chunks; inspect the bundle when source lookup fails.
async function extractFromBundleDir(
  geminiCliPackageRoot: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const bundleDir = path.join(geminiCliPackageRoot, 'bundle')
  if (!(await fileExists(bundleDir))) {
    return null
  }

  let entries: string[]
  try {
    entries = (await readdir(bundleDir)).filter((f) => f.endsWith('.js'))
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

// Find the named package within bounded ancestors or known global Node layouts.
async function findGeminiPackageRoot(realGeminiPath: string): Promise<string | null> {
  const MAX_ASCENTS = 8
  let current = path.dirname(realGeminiPath)

  for (let i = 0; i <= MAX_ASCENTS; i++) {
    const pkgJson = path.join(current, 'package.json')
    if (await fileExists(pkgJson)) {
      try {
        const raw = await readFile(pkgJson, 'utf-8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name === '@google/gemini-cli') {
          return current
        }
      } catch {
        // Malformed package metadata must not stop the ancestor search.
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
    if (await fileExists(globalPkg)) {
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
    if (await fileExists(windowsGlobalPkg)) {
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

export async function extractOAuthClientCredentials(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  const geminiPath = await resolveGeminiBinary()
  if (!geminiPath) {
    return null
  }

  const realPath = await resolveSymlink(geminiPath)

  const fromKnown = await extractFromKnownPaths(realPath)
  if (fromKnown) {
    return fromKnown
  }

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
