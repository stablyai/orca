import { DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'

type SetupCompletionHost = {
  waitForSetupTerminalCompletion: (
    handle: string,
    signal?: AbortSignal
  ) => Promise<{ exitCode: number | null }>
}

export async function waitForRequiredSetup(
  host: SetupCompletionHost,
  receipt: { startupPolicy: string; state: string; terminalHandle?: string } | undefined,
  agent: string
): Promise<void> {
  if (
    !receipt ||
    receipt.startupPolicy !== 'wait-for-setup' ||
    receipt.state === 'skipped' ||
    receipt.state === 'not_configured' ||
    receipt.state === 'succeeded' ||
    receipt.state === 'not_applicable'
  )
    return
  const failure = () =>
    new Error(
      `${agent} did not start because Setup did not finish successfully. Check the Setup terminal and try again.`
    )
  if (receipt.state !== 'running' || !receipt.terminalHandle) throw failure()
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const completion = await Promise.race([
      host.waitForSetupTerminalCompletion(receipt.terminalHandle, abort.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure()), DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS * 1000)
      })
    ])
    if (completion.exitCode !== 0) throw failure()
  } catch {
    throw failure()
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
