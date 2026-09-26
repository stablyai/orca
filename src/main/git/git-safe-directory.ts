/**
 * Detect Git "dubious ownership" / safe.directory failures and turn them into
 * actionable import errors so repos:add never persists an empty kind:git project (#12627).
 */
import { extractExecError } from './exec-error'
import { gitExecFileAsync } from './runner'

export function isGitDubiousOwnershipError(error: unknown): boolean {
  const { stderr, stdout } = extractExecError(error)
  const text = `${stderr}\n${stdout}`
  // Why: Git prints "detected dubious ownership" and names safe.directory in the hint.
  return /dubious ownership|safe\.directory/i.test(text)
}

export function formatGitDubiousOwnershipRemediation(repoPath: string): string {
  const escapedPath = JSON.stringify(repoPath)
    .replaceAll('$', '\\u0024')
    .replaceAll('`', '\\u0060')
    .replaceAll('!', '\\u0021')
  return [
    'Git refuses to use this repository because of dubious ownership.',
    `Repository path (escaped display): ${escapedPath}`,
    'Trust that exact path with Git safe.directory (quote it for your shell), for example:',
    'git config --global --add safe.directory <path>',
    'On WSL-backed checkouts, run that inside the distro using the Linux path Git sees, not a Windows UNC path.',
    'Then re-add the project in Orca. Prefer a scoped development root over safe.directory=*.'
  ].join('\n')
}

/**
 * Probe whether Git will actually operate on this path.
 * Returns a remediation message for ownership blocks; null when Git can open the repo
 * or the failure is unrelated (caller keeps existing behavior).
 */
export async function getLocalGitRepoAccessBlocker(repoPath: string): Promise<string | null> {
  try {
    await gitExecFileAsync(['rev-parse', '--git-dir'], { cwd: repoPath })
    return null
  } catch (error) {
    if (isGitDubiousOwnershipError(error)) {
      return formatGitDubiousOwnershipRemediation(repoPath)
    }
    return null
  }
}
