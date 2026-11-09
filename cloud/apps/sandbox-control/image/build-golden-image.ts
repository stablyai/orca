// Operator CLI. Dry run by default (prints the plan, touches nothing). With --execute it builds in
// Orca's Vercel team and prints {imageVersion, snapshotId, report}; set GOLDEN_SNAPSHOT_ID from it.
//   pnpm --filter @orca-cloud/sandbox-control exec tsx image/build-golden-image.ts [--release v1.4.256] [--execute]
// --release pins the released orca-server tarball + checksum; without it the manifest's bundleUrl is used.
// --execute needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID in the environment (never in git).
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'
import {
  ManifestSchema,
  VM_SCRIPTS,
  buildGoldenImage,
  manifestGaps,
  provisionEnv,
  resolveReleaseBundle,
  type BuildInputs
} from './golden-image'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url).href)

function loadInputs(): BuildInputs {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(here('./golden-image.manifest.json'), 'utf8')))
  const vmScripts = Object.fromEntries(
    VM_SCRIPTS.map((name) => [name, readFileSync(here(`./vm/${name}`), 'utf8')])
  ) as BuildInputs['vmScripts']
  return {
    manifest,
    provisionScript: readFileSync(here('./provision-golden.sh'), 'utf8'),
    vmScripts,
    buildId: randomBytes(4).toString('hex')
  }
}

async function main(): Promise<void> {
  const inputs = loadInputs()
  const releaseFlag = process.argv.indexOf('--release')
  if (releaseFlag !== -1) {
    const pinned = await resolveReleaseBundle(process.argv[releaseFlag + 1] ?? '')
    inputs.manifest = { ...inputs.manifest, orcad: { bundleUrl: pinned.bundleUrl, sha256: pinned.sha256 } }
  }
  const execute = process.argv.includes('--execute')
  const gaps = manifestGaps(inputs.manifest)
  if (!execute) {
    const env = provisionEnv(inputs)
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          manifest: inputs.manifest,
          provisionEnvKeys: Object.keys(env),
          steps: ['createBuildSandbox', 'provision-golden.sh', 'orca-image-wipe', 'createSnapshot(expiration=0)', 'deleteBuildSandbox'],
          gaps
        },
        null,
        2
      )
    )
    return
  }
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env
  if (!VERCEL_TOKEN || !VERCEL_TEAM_ID || !VERCEL_PROJECT_ID) {
    throw new Error('--execute needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID')
  }
  const provider = createVercelSandboxApi({ token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID })
  const result = await buildGoldenImage(provider, inputs, (line) => console.error(`[golden] ${line}`))
  console.log(JSON.stringify(result))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
