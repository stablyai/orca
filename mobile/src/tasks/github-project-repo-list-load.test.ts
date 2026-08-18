import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Wiring assertions only. The repo-list behaviour itself (caching, client
 *  scoping, stale responses, retry) is covered behaviourally in
 *  host-repo-list.test.ts and use-host-repo-list.test.tsx. What cannot be
 *  reached from there is how this 15k-line route consumes the resource, so
 *  these pin the consumption points the original bug lived in. */
const source = readFileSync(new URL('../../app/h/[hostId]/tasks.tsx', import.meta.url), 'utf8')

/** Why: `slice(start, -1)` silently trims one byte instead of failing, so a
 *  missing end marker would let every assertion below pass vacuously. */
function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, `tasks.tsx must contain ${startMarker}`).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start)
  expect(end, `${startMarker} must be followed by ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

function loadTasksBody(): string {
  return block('const loadTasks = useCallback(', 'const connectLinearAccount = useCallback(')
}

describe('mobile GitHub Project repo list loading', () => {
  // Regression (#12966): project mode returned before the repo list was ever
  // loaded, so hostedRepos stayed empty and every board row was filtered out.
  it('loads the repo list before project mode bails out', () => {
    const body = loadTasksBody()
    const repoLoad = body.indexOf('const repoListRequest = repoListEnsureLoaded()')
    const repoAwait = body.indexOf('await repoListRequest')
    const projectReturn = body.indexOf("provider === 'github' && githubMode === 'project'")
    expect(repoLoad, 'loadTasks must load the repo list').toBeGreaterThan(-1)
    expect(projectReturn, 'project mode must still short-circuit loadTasks').toBeGreaterThan(-1)
    expect(repoAwait, 'the repo list must be awaited, not just started').toBeGreaterThan(repoLoad)
    expect(projectReturn, 'project mode must bail out after the repo list load').toBeGreaterThan(
      repoAwait
    )
  })

  it('still bails out before any work-item fetch in project mode', () => {
    const body = loadTasksBody()
    const projectReturn = body.indexOf("provider === 'github' && githubMode === 'project'")
    const workItemFetch = body.indexOf("provider === 'github' || provider === 'gitlab'")
    expect(workItemFetch, 'the hosted work-item fetch must still exist').toBeGreaterThan(-1)
    expect(workItemFetch, 'project mode must not reach the issue/PR fetch').toBeGreaterThan(
      projectReturn
    )
  })

  it('keeps the repo list in the resource rather than local state', () => {
    expect(source).toContain('const repos = repoList.state.repos')
    expect(source, 'a second copy of the list would drift from the resource').not.toContain(
      'const [repos, setRepos]'
    )
    expect(source).not.toContain('reposRef')
  })
})

describe('mobile GitHub Project readiness and refresh', () => {
  // `every` is vacuously true on an empty list, so readiness must ask the
  // resource whether that list is real yet rather than infer it.
  it('derives slug readiness from the resource status', () => {
    const body = block('const githubProjectRepoSlugReady = useMemo(', '  )')
    expect(body).toContain('hasSettledHostRepoList(repoList.state)')
    expect(body).toContain('[githubRepoSlugCache, hostedRepos, repoList.state]')
  })

  // Regression: readiness is only useful if the renderer consults it. Without
  // this the board renders "No project items" before the repo list arrives, and
  // the memo assertion above stays green.
  it('gates the empty state on readiness in the renderer', () => {
    const gate = block(
      "githubMode === 'project' ? (",
      '<Text style={styles.emptyText}>No project items</Text>'
    )
    expect(gate, 'the empty state must sit behind the readiness spinner').toContain(
      'githubProjectTable && !githubProjectRepoSlugReady ? ('
    )
  })

  it('re-reads the host and retries failed slug lookups on refresh', () => {
    expect(block('const refreshTasks = useCallback(', '}, [')).toContain('repoListReload()')

    const projectBody = block('const refreshGitHubProject = useCallback(', '}, [')
    expect(projectBody).toContain('dropFailedGitHubRepoSlugEntries')
    expect(projectBody).toContain('refreshTasks()')
    expect(projectBody).toContain('loadGitHubProjectTable(')
  })

  it('routes every refresh control through those callbacks', () => {
    expect(source).toContain('onRefresh={refreshTasks}')
    expect(source).toContain('onRefresh={refreshGitHubProject}')
    expect(source, 'no refresh control may call loadTasks directly').not.toContain(
      'onRefresh={() => void loadTasks('
    )
  })

  it('marks a failed slug lookup as retryable rather than resolved', () => {
    expect(source).toContain('repository: null, failed: true')
  })

  // Regression: Expo reuses this screen for the next host, so an effect-based
  // reset runs a render too late and the previous host's rows show through.
  it('clears the other client-scoped caches during render', () => {
    const body = block('if (boundClient !== client) {', '\n  }')
    expect(body).toContain('setItems([])')
    expect(body).toContain('setGithubRepoSlugCache({})')
    expect(body, 'a ref write here would leak from an abandoned render').not.toContain('.current =')
  })

  // ...and the ref half belongs in the commit phase, for the same reason.
  it('resets the selection-hydration ref in the commit phase', () => {
    expect(block('clientRef.current = client', '}, [client])')).toContain(
      'repoSelectionHydratedRef.current = false'
    )
  })
})
