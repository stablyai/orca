import { exec } from 'node:child_process'
import { access, opendir, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'

const execAsync = promisify(exec)
const MAX_BINARY_LOOKUP_OUTPUT_BYTES = 64 * 1024
export const MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_GEMINI_CLI_PACKAGE_JSON_BYTES = 1024 * 1024
export const MAX_GEMINI_CLI_BUNDLE_ENTRIES = 4_096
export const MAX_GEMINI_CLI_BUNDLE_FILES = 512
export const MAX_GEMINI_CLI_BUNDLE_BYTES = 128 * 1024 * 1024

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
  const whichCmd = process.platform === 'win32' ? 'where gemini' : 'which gemini'
  try {
    const { stdout } = await execAsync(whichCmd, {
      encoding: 'utf-8',
      maxBuffer: MAX_BINARY_LOOKUP_OUTPUT_BYTES
    })
    const trimmedOutput = stdout.trim()
    const firstLineEnd = trimmedOutput.search(/\r?\n/)
    const fromPath = trimmedOutput.slice(0, firstLineEnd === -1 ? undefined : firstLineEnd)
    if (fromPath && (await fileExists(fromPath))) {
      return fromPath
    }
  } catch {
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
      if (await fileExists(candidate)) {
        return candidate
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

type GeminiOAuthSourceRead = {
  credentials: { clientId: string; clientSecret: string } | null
  bytesRead: number
}

async function readOAuthSource(
  filePath: string,
  maxBytes = MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES
): Promise<GeminiOAuthSourceRead | null> {
  try {
    const { buffer } = await readNodeFileWithinLimit(
      filePath,
      Math.min(MAX_GEMINI_CLI_OAUTH_SOURCE_BYTES, maxBytes)
    )
    return {
      credentials: parseOAuthCredentials(buffer.toString('utf8')),
      bytesRead: buffer.length
    }
  } catch {
    return null
  }
}

export async function readGeminiOAuthCredentialsFile(
  filePath: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  return (await readOAuthSource(filePath))?.credentials ?? null
}

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
    const creds = await readGeminiOAuthCredentialsFile(path.normalize(candidate))
    if (creds) {
      return creds
    }
  }

  return null
}

// Why: newer Gemini CLI versions (>=0.38) ship everything bundled into hash-named
// chunks with no oauth2.js source file. Scanning the bundle dir for the credential
// constants is the only reliable fallback for those installs.
export async function extractGeminiOAuthCredentialsFromBundleDir(
  geminiCliPackageRoot: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  const bundleDir = path.join(geminiCliPackageRoot, 'bundle')
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(bundleDir, { bufferSize: 32 })
  } catch {
    return null
  }

  let inspectedEntries = 0
  let inspectedFiles = 0
  let inspectedBytes = 0
  try {
    while (
      inspectedEntries < MAX_GEMINI_CLI_BUNDLE_ENTRIES &&
      inspectedFiles < MAX_GEMINI_CLI_BUNDLE_FILES
    ) {
      const entry = await directory.read()
      if (!entry) {
        return null
      }
      inspectedEntries += 1
      if (!entry.name.endsWith('.js')) {
        continue
      }
      inspectedFiles += 1
      const remainingBytes = MAX_GEMINI_CLI_BUNDLE_BYTES - inspectedBytes
      if (remainingBytes === 0) {
        return null
      }
      const source = await readOAuthSource(path.join(bundleDir, entry.name), remainingBytes)
      if (!source) {
        continue
      }
      if (source.bytesRead > MAX_GEMINI_CLI_BUNDLE_BYTES - inspectedBytes) {
        return null
      }
      inspectedBytes += source.bytesRead
      if (source.credentials) {
        return source.credentials
      }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      await directory.close()
    } catch {
      // Cleanup failure must not mask credential discovery.
    }
  }
}

// Resolves the gemini-cli package root directory by walking up the directory
// tree from the real binary path, looking for package.json with the right name,
// or the global Node layout under lib/node_modules.
export async function findGeminiPackageRoot(realGeminiPath: string): Promise<string | null> {
  const MAX_ASCENTS = 8
  let current = path.dirname(realGeminiPath)

  for (let i = 0; i <= MAX_ASCENTS; i++) {
    const pkgJson = path.join(current, 'package.json')
    try {
      const { buffer } = await readNodeFileWithinLimit(pkgJson, MAX_GEMINI_CLI_PACKAGE_JSON_BYTES)
      const pkg = JSON.parse(buffer.toString('utf8')) as { name?: string }
      if (pkg.name === '@google/gemini-cli') {
        return current
      }
    } catch {
      // Missing, malformed, or oversized package.json — keep walking.
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

  // 1. Known static paths (fast, covers most installs with source layout)
  const fromKnown = await extractFromKnownPaths(realPath)
  if (fromKnown) {
    return fromKnown
  }

  // 2. Walk up to find the package root, then try source layout + bundle dir
  const packageRoot = await findGeminiPackageRoot(realPath)
  if (packageRoot) {
    const fromSource =
      (await readGeminiOAuthCredentialsFile(
        path.join(packageRoot, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH)
      )) ?? (await readGeminiOAuthCredentialsFile(path.join(packageRoot, OAUTH2_SUBPATH)))
    if (fromSource) {
      return fromSource
    }

    const fromBundle = await extractGeminiOAuthCredentialsFromBundleDir(packageRoot)
    if (fromBundle) {
      return fromBundle
    }
  }

  return null
}
