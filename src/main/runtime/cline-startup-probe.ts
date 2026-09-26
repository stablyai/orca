import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { isClineStartupPromptPreview } from './cline-terminal-readiness'

export async function observeClineStartup(input: {
  readScreen: () => Promise<RuntimeTerminalRead | null>
  isCurrent: () => boolean
  timeoutMs: number
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs
  let previous: string | null = null
  let stableSince = 0
  while (Date.now() < deadline && input.isCurrent()) {
    const screen = await input.readScreen()
    if (!input.isCurrent() || Date.now() >= deadline) {
      return false
    }
    const text = screen?.tail.join('\n') ?? ''
    if (
      screen?.source !== 'screen' ||
      screen.status !== 'running' ||
      screen.truncated ||
      screen.limited ||
      screen.draft?.trim() ||
      !isClineStartupPromptPreview(text)
    ) {
      previous = null
    } else if (text !== previous) {
      previous = text
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 3000) {
      return true
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(300, Math.max(0, deadline - Date.now())))
    )
  }
  return false
}
