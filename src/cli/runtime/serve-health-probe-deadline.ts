import type { ServeRuntimeHealth } from './serve-runtime-health'

export async function probeServeHealthWithDeadline(
  probe: () => Promise<ServeRuntimeHealth>,
  timeoutMs: number
): Promise<ServeRuntimeHealth> {
  return await new Promise((resolveHealth) => {
    let completed = false
    const finish = (health: ServeRuntimeHealth): void => {
      if (completed) {
        return
      }
      completed = true
      clearTimeout(timeout)
      resolveHealth(health)
    }
    const timeout = setTimeout(
      () => finish({ healthy: false, reason: 'runtime_unreachable' }),
      timeoutMs
    )
    timeout.unref?.()
    void Promise.resolve()
      .then(probe)
      .then(finish, () => finish({ healthy: false, reason: 'runtime_unreachable' }))
  })
}
