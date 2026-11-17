import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ORCAD_CLI_PACKAGE_FILENAME } from '../../shared/remote-runtime/orcad-distribution/orcad-artifacts'

/** Written beside the server by the Orca Cloud golden build (sandbox-control image/source-build.sh). */
export const ORCAD_SOURCE_COMMIT_FILENAME = 'SOURCE_COMMIT'

const FULL_COMMIT = /^[0-9a-f]{40}$/

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The commit this orcad bundle was built from. SOURCE_COMMIT wins: a golden built from uploaded
 * source runs `git rev-parse` on a synthetic commit, so the package stamp there is not the real one.
 */
export async function readOrcadBuildCommit(installRoot: string): Promise<string | null> {
  const stamped = (await readText(join(installRoot, ORCAD_SOURCE_COMMIT_FILENAME)))
    ?.trim()
    .toLowerCase()
  if (stamped && FULL_COMMIT.test(stamped)) {
    return stamped
  }
  const pkg = await readText(join(installRoot, ...ORCAD_CLI_PACKAGE_FILENAME.split('/')))
  if (!pkg) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(pkg)
    const commit =
      parsed && typeof parsed === 'object' && 'commit' in parsed ? parsed.commit : undefined
    return typeof commit === 'string' && FULL_COMMIT.test(commit) ? commit : null
  } catch {
    return null
  }
}
