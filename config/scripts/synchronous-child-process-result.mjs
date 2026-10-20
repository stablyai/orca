export function forwardSynchronousChildFailure(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
