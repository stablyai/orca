// Codex's Windows updater extracts its downloaded package with the first `tar` on PATH
// (openai/codex#46738). In Git Bash-inherited environments Git for Windows' GNU tar precedes
// System32 and reads a native `C:\...` path as a remote host named C, so the extraction fails and
// the old daemon package stays selected (#32127). Front a tar.cmd shim that forwards to Windows'
// own tar on Codex launch environments only; the user's terminal PATH is untouched.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { createStructuredAgentEnvironmentResolvers } from '../runtime/agent-session/environment/structured-agent-shell-environment'

const SHIM_DIRECTORY_NAME = 'codex-tar-shim'
const TAR_CMD_NAME = 'tar.cmd'
const TAR_SHIM = '@"%SystemRoot%\\System32\\tar.exe" %*\r\n'

const ensuredByDirectory = new Map<string, Promise<string | null>>()

/** Create (cached per directory; a failed attempt retries on the next launch) the shim directory a Codex launch puts first on PATH; null leaves PATH as-is. */
export function ensureCodexWindowsTarShimDirectory(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform !== 'win32') {
    return Promise.resolve(null)
  }
  let ensured = ensuredByDirectory.get(dataDirectory)
  if (!ensured) {
    ensured = writeShim(join(dataDirectory, SHIM_DIRECTORY_NAME)).catch((error: unknown) => {
      console.warn(
        '[codex] Windows tar shim could not be created; Codex PATH left unchanged:',
        error
      )
      // A transient failure must not pin null for every later launch.
      ensuredByDirectory.delete(dataDirectory)
      return null
    })
    ensuredByDirectory.set(dataDirectory, ensured)
  }
  return ensured
}

async function writeShim(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const shimPath = join(directory, TAR_CMD_NAME)
  if ((await readFile(shimPath, 'utf8').catch(() => null)) !== TAR_SHIM) {
    await writeFile(shimPath, TAR_SHIM)
  }
  return directory
}

/** Move the shim directory ahead of every PATH entry, the way promoteAgentTeamsShimPath fronts its shim. */
export function frontCodexWindowsTarShimPath(
  env: Record<string, string>,
  shimDirectory: string | null,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (platform !== 'win32' || !shimDirectory) {
    return env
  }
  // Node passes the lexicographically first case-insensitive PATH key to Windows children.
  const pathKeys = Object.keys(env)
    .filter((key) => key.toLowerCase() === 'path' && env[key] !== undefined)
    .sort()
  if (pathKeys.length === 0) {
    return env
  }
  const [pathKey] = pathKeys
  const normalizedEnv = { ...env }
  for (const key of pathKeys.slice(1)) {
    delete normalizedEnv[key]
  }
  const remaining = normalizedEnv[pathKey]
    .split(';')
    .filter((entry) => entry.length > 0 && !samePathEntry(entry, shimDirectory))
  return { ...normalizedEnv, [pathKey]: [shimDirectory, ...remaining].join(';') }
}

function samePathEntry(entry: string, directory: string): boolean {
  return (
    entry.replace(/[\\/]+$/, '').toLowerCase() === directory.replace(/[\\/]+$/, '').toLowerCase()
  )
}

type StructuredAgentEnvironmentResolvers = ReturnType<
  typeof createStructuredAgentEnvironmentResolvers
>

/** Codex chat children resolve `tar` to Windows' own copy first; every other agent passes through. */
export function withCodexWindowsTarShimResolvers(
  resolvers: StructuredAgentEnvironmentResolvers,
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform
): StructuredAgentEnvironmentResolvers {
  if (platform !== 'win32') {
    return resolvers
  }
  return {
    ...resolvers,
    resolveAgentEnvironment: async (agent: string) => {
      const env = await resolvers.resolveAgentEnvironment(agent)
      return agent === 'codex'
        ? frontCodexWindowsTarShimPath(
            env,
            await ensureCodexWindowsTarShimDirectory(dataDirectory, platform),
            platform
          )
        : env
    }
  }
}
