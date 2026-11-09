import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Integration-branch backends baked into main (packaged builds read no shell env); build-time env overrides the file. */
export function cloudBuildDefaultsDefine(env: NodeJS.ProcessEnv = process.env): string {
  const file: { billingApiUrl?: string; cloudSandboxUrl?: string } = JSON.parse(
    readFileSync(resolve('config/cloud-build-defaults.json'), 'utf8')
  )
  return JSON.stringify({
    billingApiUrl: env.ORCA_BUILD_BILLING_API_URL || file.billingApiUrl,
    cloudSandboxUrl: env.ORCA_BUILD_CLOUD_SANDBOX_URL || file.cloudSandboxUrl
  })
}
