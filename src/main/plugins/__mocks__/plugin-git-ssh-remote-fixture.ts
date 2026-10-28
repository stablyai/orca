import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'

/** Serves local repositories at `ssh://git@<any host><path>` through a GIT_SSH_COMMAND shim,
 *  because plugin downloads refuse the file transport even behind an insteadOf rewrite. */
export async function serveRepositoriesOverTestSsh(
  shimDirectory: string,
  repositories: Record<string, string>
): Promise<void> {
  const shim = join(shimDirectory, 'git-ssh-shim.cjs')
  await writeFile(
    shim,
    await readFile(join(import.meta.dirname, '..', 'plugin-private-marketplace-ssh-shim.cjs'))
  )
  const node = process.execPath.replaceAll('\\', '/')
  vi.stubEnv('GIT_SSH_COMMAND', `"${node}" "${shim.replaceAll('\\', '/')}"`)
  vi.stubEnv('GIT_SSH_VARIANT', 'ssh')
  vi.stubEnv('ORCA_TEST_SSH_REPOSITORIES', JSON.stringify(repositories))
}
