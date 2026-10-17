import {
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

const PROJECT_ID_CACHE_MAX_ENTRIES = 256

// Why: a project's numeric id never changes for its path, and MR lists filter heads by it.
const projectIds = new Map<string, number>()

/** The numeric id GitLab filters merge requests by (`source_project_id`), or null if unknown. */
export async function getGitLabProjectId(
  project: ProjectRef,
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<number | null> {
  const key = `${project.host}\0${project.path}`
  const cached = projectIds.get(key)
  if (cached !== undefined) {
    return cached
  }
  const { stdout } = await glabExecFileAsync(
    ['api', ...glabHostnameArgs(project, connectionId), `projects/${encodedProject(project.path)}`],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const parsed: { id?: unknown } = JSON.parse(stdout)
  if (typeof parsed.id !== 'number') {
    return null
  }
  projectIds.set(key, parsed.id)
  if (projectIds.size > PROJECT_ID_CACHE_MAX_ENTRIES) {
    const oldest = projectIds.keys().next().value
    if (oldest !== undefined) {
      projectIds.delete(oldest)
    }
  }
  return parsed.id
}

export function _resetGitLabProjectIdCacheForTests(): void {
  projectIds.clear()
}
