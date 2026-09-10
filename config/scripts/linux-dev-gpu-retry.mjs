const GPU_LAUNCH_FAILURE = /GPU process launch failed: error_code=1002/g
const GPU_FATAL = "GPU process isn't usable"

export function inspectLinuxDevGpuOutput(output, previousFailures = 0) {
  const failures = previousFailures + (output.match(GPU_LAUNCH_FAILURE) ?? []).length
  return {
    failures,
    retry: failures >= 3 || output.includes(GPU_FATAL)
  }
}
