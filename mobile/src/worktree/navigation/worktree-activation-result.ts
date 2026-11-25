export function headlessActivationNeedsHostRenderer(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === 'object' &&
    'sleepingAgentWake' in result &&
    result.sleepingAgentWake === 'unsupported-headless'
  )
}
