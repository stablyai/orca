// Golden image build: one throwaway build sandbox → provision → wipe identity → snapshot (kept until
// deleted) → delete the build sandbox. Every Orca Cloud sandbox boots from the resulting snapshot.
import { z } from 'zod'
import type { GoldenImageProviderApi } from '../src/golden-image-provider'
import type { SandboxProviderApi } from '../src/sandbox-provider'

export const VM_SCRIPTS = ['orca-sandbox-start', 'orca-sandbox-drain', 'orca-egress-probe', 'orca-image-wipe'] as const

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Package = z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+[A-Za-z0-9.-]*$/)

export const ManifestSchema = z
  .object({
    imageVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$/),
    runtime: z.string().min(1),
    region: z.string().regex(/^[a-z]{3}[0-9]$/),
    vcpus: z.number().int().min(2).max(8),
    orcad: z.object({ bundleUrl: z.url({ protocol: /^https$/ }).nullable(), sha256: Sha256.nullable() }).strict(),
    gh: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(), sha256: Sha256.nullable() }).strict(),
    agentCliPackages: z.array(Package).min(1)
  })
  .strict()
export type GoldenImageManifest = z.infer<typeof ManifestSchema>

/** Execution needs every pin; a dry run may show a manifest that is still being filled in. */
export function manifestGaps(manifest: GoldenImageManifest): string[] {
  const gaps: string[] = []
  if (!manifest.orcad.bundleUrl || !manifest.orcad.sha256) {
    gaps.push('orcad.bundleUrl and orcad.sha256 (linux-x64 bundle from `pnpm build:orcad`)')
  }
  if (Boolean(manifest.gh.version) !== Boolean(manifest.gh.sha256)) {
    gaps.push('gh.version and gh.sha256 must be set together')
  }
  return gaps
}

/**
 * Orca releases ship `orca-server-linux-<arch>.tar.gz` plus `orca-server-sha256sums.txt` (stablyai/orca#40280).
 * Pinning a release tag replaces the ~100 s in-sandbox source build; a manual bundleUrl/sha256 stays the fallback.
 */
export async function resolveReleaseBundle(
  tag: string,
  arch: 'x64' | 'arm64' = 'x64',
  doFetch: typeof fetch = fetch
): Promise<{ bundleUrl: string; sha256: string }> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`release tag must look like v1.2.3: ${tag}`)
  }
  const base = `https://github.com/stablyai/orca/releases/download/${tag}`
  const asset = `orca-server-linux-${arch}.tar.gz`
  const response = await doFetch(`${base}/orca-server-sha256sums.txt`)
  if (!response.ok) {
    throw new Error(`${tag} has no orca-server-sha256sums.txt (HTTP ${response.status}); use the source build`)
  }
  const line = (await response.text()).split('\n').find((l) => l.trim().endsWith(asset))
  const sha256 = line?.trim().split(/\s+/)[0]
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`${tag} lists no checksum for ${asset}`)
  }
  return { bundleUrl: `${base}/${asset}`, sha256 }
}

export type BuildInputs = {
  manifest: GoldenImageManifest
  provisionScript: string
  vmScripts: Record<(typeof VM_SCRIPTS)[number], string>
  buildId: string
}

const BUILD_TIMEOUT_MS = 40 * 60_000
const PROVISION_TIMEOUT_MS = 30 * 60_000

export function provisionEnv(inputs: BuildInputs): Record<string, string> {
  const { manifest } = inputs
  const env: Record<string, string> = {
    ORCAD_BUNDLE_URL: manifest.orcad.bundleUrl ?? '',
    ORCAD_BUNDLE_SHA256: manifest.orcad.sha256 ?? '',
    AGENT_NPM_PACKAGES: manifest.agentCliPackages.join(' ')
  }
  if (manifest.gh.version && manifest.gh.sha256) {
    env.GH_VERSION = manifest.gh.version
    env.GH_SHA256 = manifest.gh.sha256
  }
  for (const name of VM_SCRIPTS) {
    env[`ORCA_VM_SCRIPT_${name.replaceAll('-', '_')}`] = Buffer.from(inputs.vmScripts[name]).toString('base64')
  }
  return env
}

export type BuildResult = {
  imageVersion: string
  snapshotId: string
  report: unknown
}

type Provider = Pick<SandboxProviderApi, 'runCommand'> & GoldenImageProviderApi

export async function buildGoldenImage(
  provider: Provider,
  inputs: BuildInputs,
  log: (line: string) => void = () => {}
): Promise<BuildResult> {
  const gaps = manifestGaps(inputs.manifest)
  if (gaps.length > 0) {
    throw new Error(`manifest incomplete: ${gaps.join('; ')}`)
  }
  const name = `orca-golden-${inputs.manifest.imageVersion.replace('.', '-')}-${inputs.buildId}`
  log(`creating build sandbox ${name}`)
  const state = await provider.createBuildSandbox({
    name,
    runtime: inputs.manifest.runtime,
    vcpus: inputs.manifest.vcpus,
    region: inputs.manifest.region,
    timeoutMs: BUILD_TIMEOUT_MS,
    tags: { orcaGoldenImage: inputs.manifest.imageVersion }
  })
  try {
    log('provisioning')
    const provision = await provider.runCommand(state.session.id, {
      command: 'bash',
      args: ['-c', inputs.provisionScript],
      env: provisionEnv(inputs),
      timeoutMs: PROVISION_TIMEOUT_MS
    })
    if (provision.exitCode !== 0) {
      throw new Error(`provision failed (exit ${provision.exitCode}): ${provision.stderr.slice(-2000)}`)
    }
    const report: unknown = JSON.parse(provision.stdout.trim().split('\n').at(-1) ?? 'null')
    log('wiping identity and auth homes')
    const wipe = await provider.runCommand(state.session.id, {
      command: '/opt/orca/bin/orca-image-wipe',
      timeoutMs: 60_000
    })
    if (wipe.exitCode !== 0 || !wipe.stdout.includes('"wiped":true')) {
      throw new Error(`identity wipe failed: ${wipe.stderr.slice(-500)}`)
    }
    log('snapshotting')
    const snapshotId = await provider.createSnapshot(state.session.id, 0)
    return { imageVersion: inputs.manifest.imageVersion, snapshotId, report }
  } finally {
    log(`deleting build sandbox ${name}`)
    await provider.deleteBuildSandbox(name)
  }
}
