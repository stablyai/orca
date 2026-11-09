// Seeds a new org environment from a local checkout: the first setup command Orca's importers find
// (Conductor, dev container, Cursor, ...) and the env var NAMES those configs expect. No values.
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { OrcaCloudRepoSetupImports } from '../../../shared/hosted-sandbox/hosted-environment-api'
import { HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS } from '../../../shared/hosted-sandbox/hosted-environment-wire'
import { inspectSetupEnvVarNames } from '../../../shared/workspace-setup/setup-env-var-name-imports'
import { SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES } from '../../../shared/workspace-setup/setup-script-import-limits'
import { inspectSetupScriptImportCandidates } from '../../../shared/workspace-setup/setup-script-imports'
import { HostedEnvironmentUserError } from './hosted-environment-client'

/**
 * `registeredRepoPaths` are the local checkouts in main's repo store; the renderer can only name
 * one of them. Every file is resolved through realpath and must stay inside the repo, so a
 * symlinked `.devcontainer/` or `.conductor/` cannot point the importer elsewhere on disk.
 */
export async function readRepoSetupImports(
  repoPath: unknown,
  registeredRepoPaths: readonly string[]
): Promise<OrcaCloudRepoSetupImports> {
  if (typeof repoPath !== 'string' || !isAbsolute(repoPath) || repoPath.length > 4096) {
    throw new HostedEnvironmentUserError('invalid_request', 'repo_path', 'Invalid repository path.')
  }
  const root = await realpath(repoPath).catch(() => null)
  const registered = await Promise.all(
    registeredRepoPaths.map((path) => realpath(path).catch(() => null))
  )
  if (!root || !registered.includes(root)) {
    throw new HostedEnvironmentUserError(
      'not_found',
      'repo_not_registered',
      'That folder is not a project in Orca. Add it as a project first.'
    )
  }
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new HostedEnvironmentUserError('not_found', null, 'Repository folder not found.')
  }

  /** The file's real path when it is a regular file inside the repo, else null. */
  const resolveInside = async (relativePath: string): Promise<string | null> => {
    if (isAbsolute(relativePath)) {
      return null
    }
    const real = await realpath(join(root, relativePath)).catch(() => null)
    if (!real) {
      return null
    }
    const rel = relative(root, real)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null
    }
    const info = await stat(real).catch(() => null)
    return info?.isFile() && info.size <= SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES ? real : null
  }
  const fileExists = async (relativePath: string): Promise<boolean> =>
    (await resolveInside(relativePath)) !== null
  const read = async (relativePath: string): Promise<string | null> => {
    const real = await resolveInside(relativePath)
    return real ? readFile(real, 'utf8').catch(() => null) : null
  }

  const [candidates, envNames] = await Promise.all([
    inspectSetupScriptImportCandidates(read, { fileExists }),
    inspectSetupEnvVarNames(read)
  ])
  const sources: string[] = []
  const first = candidates.find(
    (candidate) => candidate.setup.length <= HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS
  )
  if (first) {
    sources.push(`${first.label} (${first.files.join(', ')})`)
  }
  for (const file of envNames.files) {
    sources.push(`Environment variable names (${file})`)
  }
  return {
    envVarNames: envNames.names,
    ...(first ? { installScript: first.setup } : {}),
    sources
  }
}
