import { MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS } from '../hooks/mobile-dictation-session-state'

export async function acquireMobileWebSpeechStartupWake(
  runtime: { acquireKeepAwake: (dictationId: string) => Promise<void> },
  dictationId: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS)
    runtime
      .acquireKeepAwake(dictationId)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}
