export class PipelineV2LaunchRefusedError extends Error {
  constructor(error: unknown) {
    super(
      error instanceof Error && /^pipeline_[a-z_]{1,120}$/.test(error.message)
        ? error.message
        : 'pipeline_launch_refused'
    )
    this.name = 'PipelineV2LaunchRefusedError'
  }
}
