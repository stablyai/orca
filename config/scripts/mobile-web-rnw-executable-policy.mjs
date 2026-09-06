const runtimeCodeGenerationPattern = /\beval\s*\(|\bnew\s+Function\s*\(|sourceMappingURL/
const buildEnvironmentPathPattern =
  /(?:\/Users\/[^/"'\s]+\/|\/home\/[^/"'\s]+\/|[A-Za-z]:\\\\Users\\\\[^\\/"'\s]+\\\\)/
const telemetryIntegrationPattern =
  /\b(?:Sentry|PostHog|Crashlytics)\b|(?:sentry\.io|api\.posthog\.com|segment\.io)/i
const testFixturePattern = /\b(?:EXPO_PUBLIC_)?ORCA_E2E_[A-Z0-9_]+\b/
const nativeCredentialAuthorityPattern =
  /orca(?:\.host-token\.|:web-host-token:)|scheduleHostCredentialCleanup|openHostLogicalClient|resolvePairingHostIdentity|deleteMobileRelayCredentialBundle/

const pagePersistencePatterns = [
  /\b(?:window\.)?(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem|clear|key)\b/,
  /\bindexedDB\s*\.\s*(?:open|deleteDatabase|databases)\b/,
  /\b(?:window\.)?caches\s*\.\s*(?:open|match|has|delete|keys)\b/,
  /\bdocument\s*\.\s*cookie\b/,
  /\bopenDatabase\s*\(/,
  /\bnavigator\s*\.\s*storage\s*\.\s*(?:getDirectory|persist|persisted)\b/
]

export function mobileWebRnwExecutablePolicyFailure(source) {
  if (runtimeCodeGenerationPattern.test(source)) {
    return 'runtime code generation'
  }
  if (buildEnvironmentPathPattern.test(source)) {
    return 'build environment path disclosure'
  }
  if (telemetryIntegrationPattern.test(source)) {
    return 'hosted telemetry integration'
  }
  if (testFixturePattern.test(source)) {
    return 'test fixture marker'
  }
  if (nativeCredentialAuthorityPattern.test(source)) {
    return 'native credential authority'
  }
  if (pagePersistencePatterns.some((pattern) => pattern.test(source))) {
    return 'page-owned persistence'
  }
  return null
}

export function assertMobileWebRnwExecutablePolicy(source) {
  const failure = mobileWebRnwExecutablePolicyFailure(source)
  if (failure) {
    throw new Error(`RNW executable contains ${failure}`)
  }
}
