import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'

export const OMP_RPC_INITIAL_READY_DEADLINE_MS = 15_000

export async function waitForOmpRpcInitialReady(
  client: OmpSessionOwningRpcClient,
  deadlineMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.whenReady(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OMP RPC initial readiness timed out after ${deadlineMs}ms`)),
          deadlineMs
        )
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
