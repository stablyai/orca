import type {
  GitLabJobTraceResult,
  GitLabPipelineJob,
  GitLabRetryJobResult
} from '../../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import { acquire, release } from '../requests/glab-request-admission'
import {
  classifyGlabError,
  classifyJobLogError,
  isMissingJobLogError
} from '../requests/glab-error-classification'
import { glabHostnameArgs, glabRepoExecOptions } from '../projects/gitlab-project-ref-resolution'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import type { LocalGitExecOptions } from '../projects/gitlab-known-host-probe'
import type { ProjectRef } from '../projects/project-ref-parser'
import { encodedProject } from '../projects/project-path-encoding'
import { gitLabRunTimes } from './gitlab-run-times'
import { withProjectRef } from '../merge-requests/merge-request-project-resolution'
import { codeHostFailure, classifiedFailure } from '../../../shared/code-host-failure-copy'

// Large traces need more than the runner default; the renderer also bounds the call.
const JOB_TRACE_EXEC_TIMEOUT_MS = 60_000

function mapRetriedPipelineJob(
  data: {
    id?: number
    pipeline?: { id?: number | null } | null
    name?: string
    stage?: string
    status?: string
    allow_failure?: boolean
    web_url?: string
    duration?: number | null
    started_at?: string | null
    finished_at?: string | null
  },
  fallbackJobId: number
): GitLabPipelineJob {
  return {
    id: data.id ?? fallbackJobId,
    ...(typeof data.pipeline?.id === 'number' ? { pipelineId: data.pipeline.id } : {}),
    name: data.name ?? '',
    stage: data.stage ?? '',
    status: data.status ?? '',
    ...(typeof data.allow_failure === 'boolean' ? { allowFailure: data.allow_failure } : {}),
    webUrl: data.web_url ?? '',
    duration: typeof data.duration === 'number' ? data.duration : null,
    ...gitLabRunTimes(data)
  }
}

export async function getJobTrace(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabJobTraceResult> {
  return withProjectRef<GitLabJobTraceResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            `projects/${encodedProject(projectRef.path)}/jobs/${jobId}/trace`
          ],
          {
            ...glabRepoExecOptions(repoPath, connectionId, localGitOptions),
            timeout: JOB_TRACE_EXEC_TIMEOUT_MS
          }
        )
        return { ok: true, trace: stdout }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Jobs canceled before starting can 404 with no trace; present an empty log.
        if (isMissingJobLogError(msg)) {
          return { ok: true, trace: '' }
        }
        return classifiedFailure(classifyJobLogError(msg))
      } finally {
        release()
      }
    },
    codeHostFailure('gitlab.projectUnresolved'),
    localGitOptions
  )
}

export async function retryJob(
  repoPath: string,
  jobId: number,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabRetryJobResult> {
  return withProjectRef<GitLabRetryJobResult>(
    repoPath,
    preference,
    connectionId,
    projectRef,
    async (projectRef) => {
      await acquire()
      try {
        const { stdout } = await glabExecFileAsync(
          [
            'api',
            ...glabHostnameArgs(projectRef, connectionId),
            '-X',
            'POST',
            `projects/${encodedProject(projectRef.path)}/jobs/${jobId}/retry`
          ],
          glabRepoExecOptions(repoPath, connectionId, localGitOptions)
        )
        const trimmed = stdout.trim()
        return {
          ok: true,
          ...(trimmed ? { job: mapRetriedPipelineJob(JSON.parse(trimmed), jobId) } : {})
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return classifiedFailure(classifyGlabError(msg))
      } finally {
        release()
      }
    },
    codeHostFailure('gitlab.projectUnresolved'),
    localGitOptions
  )
}
