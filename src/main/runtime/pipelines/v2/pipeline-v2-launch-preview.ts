import type { OrcaRuntimeService } from '../../orca-runtime'
import type {
  PipelineV2Stage,
  PipelineV2CompiledStage
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2TemplateShowResult } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import { pipelineV2LaunchEnvironment } from './pipeline-v2-native-launch'
import { resolvePipelineV2Launch } from './pipeline-v2-launch'

export async function previewPipelineV2Launch(
  runtime: OrcaRuntimeService,
  project: { id: string; path: string },
  stages: (PipelineV2Stage | PipelineV2CompiledStage)[]
): Promise<NonNullable<PipelineV2TemplateShowResult['launchPreview']>> {
  return Promise.all(
    stages
      .filter((stage) => stage.kind === 'agent')
      .map(async (stage) => {
        try {
          const executor = await resolvePipelineV2Launch(
            pipelineV2LaunchEnvironment(runtime),
            stage,
            { id: `${project.id}::${project.path}`, path: project.path }
          )
          return { stageId: stage.id, state: 'available' as const, executor }
        } catch (error) {
          const reason =
            error instanceof Error && /^pipeline_[a-z_]{1,120}$/.test(error.message)
              ? error.message
              : 'pipeline_launch_unavailable'
          return { stageId: stage.id, state: 'unavailable' as const, reason }
        }
      })
  )
}
