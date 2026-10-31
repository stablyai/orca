import { afterEach, expect, it, vi } from 'vitest'
import * as repoExecution from '../../github-api-repository'
import * as gh from '../../gh-utils'
import * as rateLimit from '../../rate-limit'
import { getWorkflowRunDetails } from './get-workflow-run-details'
import { prCheckLogTailCache } from '../check/check-job-log-tails'

afterEach(() => {
  vi.restoreAllMocks()
  prCheckLogTailCache.clear()
})

it.each([
  { platform: 'win32', unavailable: false },
  { platform: 'win32', unavailable: true },
  { platform: 'linux', unavailable: false },
  { platform: 'linux', unavailable: true },
  { platform: 'darwin', unavailable: false },
  { platform: 'darwin', unavailable: true }
] as const)(
  'does not reuse excerpts across execution snapshots on $platform (unavailable=$unavailable)',
  async ({ platform, unavailable }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.spyOn(gh, 'acquire').mockResolvedValue(undefined)
    vi.spyOn(gh, 'release').mockImplementation(() => {})
    vi.spyOn(rateLimit, 'repositoryRateLimitGuard').mockReturnValue({ blocked: false })
    const repository = { host: 'github.com', owner: 'acme', repo: 'widget' }
    const resolve = vi.spyOn(repoExecution, 'resolveGitHubRepoExecution')
    let logCalls = 0
    vi.spyOn(gh, 'ghExecFileAsync').mockImplementation(async (args) => {
      if (args[1]?.endsWith('/logs')) {
        logCalls += 1
        if (unavailable) {
          throw new Error('Logs unavailable for this execution owner')
        }
        return { stdout: `execution excerpt ${logCalls}`, stderr: '' }
      }
      const value = args[1]?.includes('/jobs?')
        ? {
            jobs: [
              {
                id: 99,
                name: 'Build',
                status: 'completed',
                completed_at: '2026-10-01T00:00:00Z',
                conclusion: 'failure'
              }
            ],
            total_count: 1
          }
        : { id: 9, workflow_id: 5, run_number: 1, run_attempt: 1 }
      return { stdout: JSON.stringify(value), stderr: '' }
    })
    const read = async (cwd: string, wslDistro?: string) => {
      resolve.mockResolvedValue({
        ownerRepo: repository,
        ghOptions: { cwd, wslDistro, ghAccount: { host: repository.host, user: 'same-login' } }
      })
      return (await getWorkflowRunDetails(cwd, { repository, runId: 9, noCache: !unavailable }))
        .jobs[0].logTail
    }
    const native = await read('C:/repo')
    const ubuntu = await read('//wsl.localhost/Ubuntu/home/user/repo')
    const debian = await read('\\\\wsl$\\Debian\\home\\user\\repo')
    expect(native).toBe(unavailable ? null : 'execution excerpt 1')
    expect(ubuntu).toBe(unavailable ? null : 'execution excerpt 2')
    expect(debian).toBe(unavailable ? null : 'execution excerpt 3')
    expect(await read('//wsl.localhost/Ubuntu/home/user/repo', 'Debian')).toBe(
      unavailable ? null : 'execution excerpt 4'
    )
    expect(await read('C:/repo', 'Ubuntu')).toBe(unavailable ? null : 'execution excerpt 5')
    expect(await read('/home/user/repo', 'Ubuntu')).toBe(unavailable ? null : 'execution excerpt 6')
    expect(await read('C:/repo')).toBe(native)
    expect(await read('\\\\wsl$\\Debian\\home\\user\\repo', 'Ubuntu')).toBe(
      unavailable ? null : 'execution excerpt 7'
    )
    expect(logCalls).toBe(unavailable ? 8 : 7)
  }
)
