import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const projectDir = fileURLToPath(new URL('../../../..', import.meta.url))
export const MOBILE_WEB_MANIFEST_CONTRACT = join(
  projectDir,
  'src',
  'shared',
  'mobile-web-bundle',
  'manifest-contract.ts'
)

let contract = null

// The TS contract through esbuild, which resolves its extensionless imports; loaded once per process.
export function loadMobileWebManifestContract() {
  contract ??= (async () => {
    const { outputFiles } = await esbuild.build({
      entryPoints: [MOBILE_WEB_MANIFEST_CONTRACT],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent'
    })
    const source = Buffer.from(outputFiles[0].contents).toString('base64')
    return import(`data:text/javascript;base64,${source}`)
  })()
  return contract
}

// The desktop serves no page for a manifest its contract rejects, so the build refuses to write one.
export async function assertMobileWebManifestMatchesContract(manifest) {
  const { InstalledMobileWebBundleManifestSchema } = await loadMobileWebManifestContract()
  const parsed = InstalledMobileWebBundleManifestSchema.safeParse(manifest)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    )
    throw new Error(
      `[mobile-web-bundle] manifest.json does not match the manifest contract:\n  ${issues.join('\n  ')}`
    )
  }
}
