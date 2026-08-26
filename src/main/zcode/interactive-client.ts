import { execLocalPreflightCommand } from '../ipc/preflight-command-exec'

const INTERACTIVE_DISTRIBUTION_MARKER = /^zcode-app-cli\s+\S+/m
const INTERACTIVE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000
let interactiveUnavailableUntil = 0

export function isInteractiveZcodeVersionOutput(output: string): boolean {
  return INTERACTIVE_DISTRIBUTION_MARKER.test(output)
}

export async function hasInteractiveZcodeClient(): Promise<boolean> {
  try {
    const result = await execLocalPreflightCommand('zcode', ['--version'])
    return isInteractiveZcodeVersionOutput(`${result.stdout}\n${result.stderr}`)
  } catch {
    // Capability detection must fail closed so the signed Desktop runtime can
    // still receive its prompt through the supported one-shot entry point.
    return false
  }
}

export async function resolveZcodePromptDelivery(args: {
  isRemote: boolean
  commandOverride?: string | null
  probeInteractiveClient?: () => Promise<boolean>
}): Promise<'agent-input' | 'startup-command'> {
  if (args.isRemote || args.commandOverride?.trim() || Date.now() < interactiveUnavailableUntil) {
    return 'startup-command'
  }
  const probe = args.probeInteractiveClient ?? hasInteractiveZcodeClient
  return (await probe()) ? 'agent-input' : 'startup-command'
}

export function markInteractiveZcodeUnavailable(now = Date.now()): void {
  interactiveUnavailableUntil = now + INTERACTIVE_FAILURE_COOLDOWN_MS
}

export function resetInteractiveZcodeAvailabilityForTests(): void {
  interactiveUnavailableUntil = 0
}
