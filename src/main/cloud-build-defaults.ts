// Packaged builds read no shell env, so the integration build bakes in its backend URLs
// (config/cloud-build-defaults.json via electron.vite.config.ts). Run-time env still wins.
declare const ORCA_CLOUD_BUILD_DEFAULTS: { billingApiUrl?: string; cloudSandboxUrl?: string } | null

function buildDefaults(): { billingApiUrl?: string; cloudSandboxUrl?: string } {
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  return (typeof ORCA_CLOUD_BUILD_DEFAULTS === 'undefined' ? null : ORCA_CLOUD_BUILD_DEFAULTS) ?? {}
}

export function withCloudBuildDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defaults = buildDefaults()
  return {
    ...env,
    ORCA_BILLING_API_URL: env.ORCA_BILLING_API_URL?.trim() || defaults.billingApiUrl,
    ORCA_CLOUD_SANDBOX_URL: env.ORCA_CLOUD_SANDBOX_URL?.trim() || defaults.cloudSandboxUrl
  }
}
