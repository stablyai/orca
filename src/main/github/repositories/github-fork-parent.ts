import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'
import type { GitHubRepositoryIdentity } from '../../../shared/github/repositories/repository-identity'
import { githubRepoIdentityKey } from '../../../shared/github/repositories/repository-identity-key'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { runCoalescedProbe, type CoalescedProbes } from '../../git/remotes/coalesced-probe'
import { codeHostReadExecutionScope } from '../../source-control/code-host-read-execution-scope'
import { isValidGitHubApiRepository } from './github-api-repository-validation'
import { ghRepoExecOptions, type GitHubRepoContext } from './github-repository-identity'
import { githubRepositorySlugArg, githubHostExecOptions } from './github-repository-host'

const metadata = lazyZodSchema(() =>
  z.discriminatedUnion('isFork', [
    z.object({ isFork: z.literal(false) }),
    z.object({
      isFork: z.literal(true),
      parent: z.object({ owner: z.object({ login: z.string() }), name: z.string() })
    })
  ])
)

type ForkParent = GitHubRepositoryIdentity | null
const cache = new BoundedMap<string, { parent: ForkParent; expires: number }>({ maxEntries: 512 })
const pending: CoalescedProbes<ForkParent | undefined> = new Map()
// Item detail reads can already hold a GitHub operation slot when resolving their source.
const probes = new PrioritySemaphore(4)

export async function getGitHubForkParent(
  origin: GitHubRepositoryIdentity,
  context: GitHubRepoContext
): Promise<ForkParent | undefined> {
  const options = { ...ghRepoExecOptions(context), ...githubHostExecOptions(origin) }
  const key = JSON.stringify([
    context.connectionId,
    codeHostReadExecutionScope(options),
    githubRepoIdentityKey(origin)
  ])
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) {
    return cached.parent
  }
  return runCoalescedProbe(pending, key, async (ownsKey) => {
    const signal = AbortSignal.timeout(10_000)
    const release = await probes.acquire(0, signal).catch(() => null)
    if (!release) {
      return undefined
    }
    try {
      const { stdout } = await ghExecFileAsync(
        ['repo', 'view', githubRepositorySlugArg(origin), '--json', 'isFork,parent'],
        { ...options, timeout: 10_000, signal }
      )
      const data = metadata.parse(JSON.parse(stdout))
      const parent = data.isFork
        ? { owner: data.parent.owner.login, repo: data.parent.name, host: origin.host }
        : null
      if (parent && !isValidGitHubApiRepository(parent)) {
        return undefined
      }
      if (ownsKey()) {
        cache.set(key, { parent, expires: Date.now() + 5 * 60_000 })
      }
      return parent
    } catch {
      return undefined
    } finally {
      release()
    }
  })
}
