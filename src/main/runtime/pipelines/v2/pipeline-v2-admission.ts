import { z } from 'zod'
import type { PipelineStore } from '../pipeline-store'
import { PipelineCheck } from '../../../../shared/pipelines/pipeline-contracts'
import {
  PipelineV2Task,
  type PipelineV2Definition
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineV2CreationSnapshot } from '../../../../shared/pipelines/v2/pipeline-v2-admission-contracts'
import { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { pipelineV2Id } from '../../../../shared/pipelines/v2/pipeline-v2-values'
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { resolvePipelineV2Launch, type PipelineV2LaunchEnvironment } from './pipeline-v2-launch'
import { pipelineV2MandatoryContext } from './pipeline-v2-context'

export type PipelineV2AdmissionEnvironment = {
  store: PipelineStore
  launch: PipelineV2LaunchEnvironment
  project: { id: string; path: string; kind: string; hostId: string }
}
export function assertPipelineV2AdmissionContext(
  definition: PipelineV2Definition,
  task: string
): void {
  for (const stage of definition.stages) {
    const mandatory = pipelineV2MandatoryContext(
      definition,
      stage,
      task,
      {
        runId: 'r'.repeat(64),
        revision: Number.MAX_SAFE_INTEGER,
        expectedInstanceId: 'i'.repeat(256),
        sourceRevision: 'a'.repeat(64),
        invocation: {
          id: 'v'.repeat(256),
          dispatchId: 'd'.repeat(256),
          inputRevision: Number.MAX_SAFE_INTEGER,
          sourceRevision: 'a'.repeat(64),
          reviewCommit: 'b'.repeat(64)
        }
      },
      { compactExample: true }
    )
    if (JSON.stringify(mandatory).length + 1024 > 16000) {
      throw new Error('pipeline_context_budget')
    }
  }
}
export async function admitPipelineV2(
  host: PipelineV2AdmissionEnvironment,
  rawSelection: unknown,
  rawTask: unknown,
  rawCreationId: unknown,
  creationPayload?: unknown
): Promise<PipelineV2CreationSnapshot & { fresh: boolean }> {
  const selection = PipelineV2TemplateSelection.parse(rawSelection)
  const task = PipelineV2Task.parse(rawTask)
  const creationId = pipelineV2Id.parse(rawCreationId)
  if (host.project.id !== selection.projectId) {
    throw new Error('pipeline_template_project_mismatch')
  }
  if (
    host.project.kind !== 'git' ||
    host.project.hostId !== 'local' ||
    isWslUncPath(host.project.path)
  ) {
    throw new Error('pipeline_local_git_only')
  }
  const payload = creationPayload ?? { projectId: host.project.id, selection, task }
  if (host.store.creationV2(creationId, payload)) {
    return {
      ...PipelineV2CreationSnapshot.parse(host.store.creationSnapshotV2(creationId)),
      fresh: false
    }
  }
  const { definition } = host.store.templatesV2.resolve(selection)
  assertPipelineV2AdmissionContext(definition, task)
  const configured = z
    .array(PipelineCheck)
    .max(16)
    .parse(host.store.configuredChecks(host.project.id))
  const required = new Set(
    definition.stages.flatMap((stage) => (stage.kind === 'checks' ? stage.executor.checkIds : []))
  )
  if ([...required].some((id) => !configured.some((check) => check.id === id))) {
    throw new Error('pipeline_project_checks_unconfigured')
  }
  const effectiveExecutors: PipelineV2CreationSnapshot['effectiveExecutors'] = {}
  const launch = { ...host.launch, settings: structuredClone(host.launch.settings) }
  const groups = new Map<string, string>()
  for (const stage of definition.stages) {
    if (stage.kind !== 'agent') {
      continue
    }
    const effective = await resolvePipelineV2Launch(launch, stage, {
      id: `${host.project.id}::${host.project.path}`,
      path: host.project.path
    })
    effectiveExecutors[stage.id] = effective
    if (stage.executor.session.kind === 'reuse') {
      const group = stage.executor.session.groupId
      if (groups.has(group) && groups.get(group) !== effective.compatibilityKey) {
        throw new Error('pipeline_session_policy_conflict')
      }
      groups.set(group, effective.compatibilityKey)
    }
  }
  const snapshot = PipelineV2CreationSnapshot.parse({
    schemaVersion: 2,
    creationId,
    selection,
    definition,
    task,
    effectiveExecutors,
    checkSnapshot: configured.filter((check) => required.has(check.id))
  })
  host.store.templatesV2.resolve(selection)
  const reserved = host.store.reserveCreationV2(creationId, payload, snapshot)
  return {
    ...(reserved.fresh
      ? snapshot
      : PipelineV2CreationSnapshot.parse(host.store.creationSnapshotV2(creationId))),
    fresh: reserved.fresh
  }
}
