// Packaged builds read no shell env, so the integration build bakes in its backend URLs
// (config/cloud-build-defaults.json via electron.vite.config.ts). Run-time env still wins.
type BuildServiceUrlDefaults = {
  authApiUrl?: string
  relayDirectorUrl?: string
  pushGatewayUrl?: string
  connectorUrl?: string
  artifactsApiUrl?: string
}

type CloudBuildDefaults = BuildServiceUrlDefaults & {
  billingApiUrl?: string
  cloudSandboxUrl?: string
  allowDevSigning?: boolean
}

declare const ORCA_CLOUD_BUILD_DEFAULTS: CloudBuildDefaults | null

function buildDefaults(): CloudBuildDefaults {
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  return (typeof ORCA_CLOUD_BUILD_DEFAULTS === 'undefined' ? null : ORCA_CLOUD_BUILD_DEFAULTS) ?? {}
}

export type BuildServiceUrlKey = keyof BuildServiceUrlDefaults

/** Build-time service URL default, or `fallback` when the build sets none. */
export function buildServiceUrlDefault(key: BuildServiceUrlKey, fallback: string): string {
  return buildDefaults()[key]?.trim() || fallback
}

export function withCloudBuildDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defaults = buildDefaults()
  return {
    ...env,
    ORCA_BILLING_API_URL: env.ORCA_BILLING_API_URL?.trim() || defaults.billingApiUrl,
    ORCA_CLOUD_SANDBOX_URL: env.ORCA_CLOUD_SANDBOX_URL?.trim() || defaults.cloudSandboxUrl
  }
}

/** Dev-key sandbox signing: always in unpackaged runs; in packaged builds only when the integration build opts in. */
export function cloudDevSigningAllowed(packaged: boolean): boolean {
  return !packaged || buildDefaults().allowDevSigning === true
}
