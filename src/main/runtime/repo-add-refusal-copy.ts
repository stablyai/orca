import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const FOLDER_ROUTE =
  'Use --kind folder to open a non-git folder, such as a repo-tool checkout with .repo/.'

/** Keep the `Not a valid git repository: <path>` prefix: the renderer matches it to offer a folder import. */
export async function describeNonGitRepoAddRefusal(path: string): Promise<string> {
  const looksLikeRepoTree = await stat(join(path, '.repo', 'manifest.xml'))
    .then((entry) => entry.isFile())
    .catch(() => false)
  return looksLikeRepoTree
    ? `Not a valid git repository: ${path}. This looks like a repo-tool checkout (.repo/manifest.xml) with one git repo per project and no git repo at the top level. Use --kind folder to open it as a non-git folder.`
    : `Not a valid git repository: ${path}. ${FOLDER_ROUTE}`
}
