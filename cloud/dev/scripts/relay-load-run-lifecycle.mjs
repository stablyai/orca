export function assertRelayLoadRampAccepted(rampConnectionFailures, maximum) {
  if (rampConnectionFailures > maximum) {
    throw new Error('relay load ramp exceeded the allowed connection failures')
  }
}

export async function runRelayLoadWithShutdown(operation, shutdown) {
  try {
    return await operation()
  } finally {
    await shutdown()
  }
}

export function relayLoadRunHasDisallowedFailures(result, config) {
  return (
    result.rampConnectionFailures > config.maxRampConnectionFailures ||
    (!config.allowPlannedTransitionRetries && result.transitionConnectionFailures > 0) ||
    result.steadyConnectionFailures > 0 ||
    result.unexpectedCloses > config.maxUnexpectedCloses ||
    result.protocolErrors > 0 ||
    result.refreshErrors > 0 ||
    result.socketErrors > 0
  )
}
