import type { ActionsPage } from '../../../../shared/github/actions-types'
import type {
  ActionsArtifact,
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery
} from '../../../../shared/github/actions-artifact-types'
import {
  ACTIONS_ARTIFACT_MAX_BYTES,
  ACTIONS_ARTIFACT_HOST_TIMEOUT_MS,
  ACTIONS_ARTIFACT_TIMEOUT_MESSAGE
} from '../../../../shared/github/actions-artifact-types'
import {
  ActionsArtifactsQuery as ListSchema,
  ActionsArtifactDownloadQuery as DownloadSchema
} from '../../../../shared/rpc-contract/github-actions-artifact-params'
import { ghExecFileAsync, type LocalGitExecOptions } from '../../gh-utils'
import { sanitizeLocalDownloadFilename } from '../../../local-download-filename'
import { actionsJson, withActionsRead } from './actions-read-request'
import { actionsCount, actionsNumber, actionsRecord } from './workflow-run-field-mapping'
import { nullableString } from '../check/check-detail-field-mapping'
import { artifactSessionOwner, createArtifactSession } from './artifact-download-sessions'
/** Reject malformed sizes and expiry flags before exposing artifact metadata to download callers. */
function mapArtifact(value: unknown): ActionsArtifact {
  const row = actionsRecord(value)
  const sizeBytes = actionsCount(row.size_in_bytes)
  if (sizeBytes === null || typeof row.expired !== 'boolean') {
    throw new Error('Invalid GitHub artifact metadata')
  }
  return {
    id: actionsNumber(row.id),
    name: nullableString(row.name) ?? 'artifact',
    sizeBytes,
    expired:
      row.expired ||
      Boolean(typeof row.expires_at === 'string' && Date.parse(row.expires_at) <= Date.now()),
    createdAt: nullableString(row.created_at),
    expiresAt: nullableString(row.expires_at)
  }
}
/** Read one bounded artifact page from the explicit GitHub target using the execution account. */
export function listActionsArtifacts(
  repoPath: string,
  query: ActionsArtifactsQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  signal?: AbortSignal
): Promise<ActionsPage<ActionsArtifact>> {
  const args = ListSchema.parse(query)
  const page = args.page ?? 1
  return withActionsRead(
    repoPath,
    args.repository,
    connectionId,
    localGitOptions,
    signal,
    async (repository, options) => {
      const raw = actionsRecord(
        await actionsJson(
          `repos/${repository.owner}/${repository.repo}/actions/runs/${args.runId}/artifacts?per_page=100&page=${page}`,
          options
        )
      )
      if (!Array.isArray(raw.artifacts)) {
        throw new Error('Invalid GitHub artifact page')
      }
      const items = raw.artifacts.map(mapArtifact)
      const totalCount = actionsCount(raw.total_count)
      const more = totalCount === null ? items.length === 100 : page * 100 < totalCount
      return {
        repository,
        items,
        page,
        perPage: 100,
        totalCount,
        hasNextPage: more && page < 10,
        limitReached: more && page === 10
      }
    }
  )
}
/** Verify artifact/run ownership, expiry, size and ZIP signature, then retain bytes until release or caller loss. */
export function startActionsArtifactDownload(
  repoPath: string,
  query: ActionsArtifactDownloadQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  signal?: AbortSignal,
  onRelease?: () => void
) {
  const args = DownloadSchema.parse(query)
  return withActionsRead(
    repoPath,
    args.repository,
    connectionId,
    localGitOptions,
    signal,
    async (repository, options) => {
      const endpoint = `repos/${repository.owner}/${repository.repo}/actions/artifacts/${args.artifactId}`
      const raw = actionsRecord(await actionsJson(endpoint, options))
      const artifact = mapArtifact(raw)
      if (artifact.id !== args.artifactId || actionsRecord(raw.workflow_run).id !== args.runId) {
        throw new Error('Artifact does not belong to this workflow run')
      }
      if (
        artifact.expired ||
        (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now())
      ) {
        throw new Error('This artifact has expired')
      }
      if (artifact.sizeBytes > ACTIONS_ARTIFACT_MAX_BYTES) {
        throw new Error('Artifacts larger than 64 MiB must be downloaded on GitHub')
      }
      const { stdout } = await ghExecFileAsync(['api', `${endpoint}/zip`], {
        ...options,
        encoding: 'base64',
        timeout: ACTIONS_ARTIFACT_HOST_TIMEOUT_MS,
        maxBuffer: ACTIONS_ARTIFACT_MAX_BYTES * 2
      })
      const archive = Buffer.from(stdout, 'base64')
      if (archive.length > ACTIONS_ARTIFACT_MAX_BYTES) {
        throw new Error('Artifact exceeds the 64 MiB download limit')
      }
      if (
        archive.length < 4 ||
        archive[0] !== 0x50 ||
        archive[1] !== 0x4b ||
        ![0x03, 0x05, 0x07].includes(archive[2])
      ) {
        throw new Error('GitHub did not return a ZIP archive')
      }
      options.signal?.throwIfAborted()
      return createArtifactSession(
        artifactSessionOwner(repoPath, connectionId, localGitOptions),
        archive,
        `${sanitizeLocalDownloadFilename(artifact.name)}.zip`,
        signal,
        onRelease
      )
    },
    { timeoutMs: ACTIONS_ARTIFACT_HOST_TIMEOUT_MS, message: ACTIONS_ARTIFACT_TIMEOUT_MESSAGE }
  )
}
