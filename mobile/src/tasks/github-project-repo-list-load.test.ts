import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Wiring assertions only. Keep these anchored to the modules that own each path. */
const readSource = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const taskListSource = readSource('./use-mobile-tasks-task-list-loading.tsx')
const projectProjectionSource = readSource('./use-mobile-tasks-project-projection.tsx')
const projectLoadingSource = readSource('./use-mobile-tasks-project-loading-actions.tsx')
const projectEffectsSource = readSource('./use-mobile-tasks-list-and-detail-effects.tsx')
const projectListSource = readSource('./mobile-tasks-github-project-list.tsx')
const providerItemListSource = readSource('./mobile-tasks-provider-item-list.tsx')
const screenChromeSource = readSource('./mobile-tasks-screen-chrome.tsx')
const routeAndItemStateSource = readSource('./use-mobile-tasks-route-and-item-state.tsx')
const repositoryResolutionSource = readSource(
  './use-mobile-tasks-project-repository-resolution.tsx'
)
const clientSettingsSource = readSource('./use-mobile-tasks-client-settings-actions.tsx')
const source = [
  taskListSource,
  projectProjectionSource,
  projectLoadingSource,
  projectEffectsSource,
  projectListSource,
  providerItemListSource,
  screenChromeSource,
  routeAndItemStateSource,
  repositoryResolutionSource,
  clientSettingsSource
].join('\n')

/** Why: `slice(start, -1)` silently trims one byte instead of failing, so a
 *  missing end marker would let every assertion below pass vacuously. */
function block(input: string, startMarker: string, endMarker: string): string {
  const start = input.indexOf(startMarker)
  expect(start, `source must contain ${startMarker}`).toBeGreaterThan(-1)
  const end = input.indexOf(endMarker, start)
  expect(end, `${startMarker} must be followed by ${endMarker}`).toBeGreaterThan(start)
  return input.slice(start, end)
}

function loadTasksBody(): string {
  return block(
    taskListSource,
    'const loadTasks = useCallback(',
    '  return Object.assign(model, { loadTasks })'
  )
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
    const body = block(
      projectProjectionSource,
      'const githubProjectRepoSlugReady = useMemo(',
      '  )'
    )
    expect(body).toContain('hasSettledHostRepoList(repoList.state)')
    expect(body).toContain('[githubRepoSlugCache, hostedRepos, repoList.state]')
  })

  // Regression: readiness is only useful if the renderer consults it. Without
  // this the board renders "No project items" before the repo list arrives, and
  // the memo assertion above stays green.
  it('gates the empty state on readiness in the renderer', () => {
    expect(projectListSource, 'the empty state must sit behind the readiness spinner').toContain(
      'githubProjectTable && !githubProjectRepoSlugReady ? ('
    )
  })

  it('re-reads the host and retries failed slug lookups on refresh', () => {
    expect(block(projectLoadingSource, 'const refreshTasks = useCallback(', '}, [')).toContain(
      'repoListReload()'
    )

    const projectBody = block(
      projectEffectsSource,
      'const refreshGitHubProject = useCallback(',
      '}, ['
    )
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
    const body = block(clientSettingsSource, 'if (boundClient !== client) {', '\n  }')
    expect(body).toContain('setItems([])')
    expect(body).toContain('setGithubRepoSlugCache({})')
    expect(body, 'a ref write here would leak from an abandoned render').not.toContain('.current =')
  })

  // ...and the ref half belongs in the commit phase, for the same reason.
  it('resets the selection-hydration ref in the commit phase', () => {
    expect(block(clientSettingsSource, 'clientRef.current = client', '}, [client])')).toContain(
      'repoSelectionHydratedRef.current = false'
    )
  })
})
