// Operator-only: clone an existing golden snapshot with this checkout's VM entry points (image/vm/)
// and session-env hook, without a full rebuild (~1 min instead of a source build). For script-only
// changes; agent CLIs and orcad stay as they are in the base image.
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
//     npx tsx image/patch-golden-image.ts <baseSnapshotId> [--env <tag>] [--apply]
// Dry run by default. Prints {"snapshotId": ...}. Deletes its build sandbox, keeps the new snapshot.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VM_SCRIPTS } from './golden-image'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url).href)

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2)
  const base = args.find((arg) => arg.startsWith('snap_'))
  const envTag = args.includes('--env') ? args[args.indexOf('--env') + 1]! : 'dev'
  if (!base) {
    throw new Error('usage: patch-golden-image.ts <baseSnapshotId> [--env <tag>] [--apply]')
  }
  const scripts = Object.fromEntries(VM_SCRIPTS.map((name) => [name, readFileSync(here(`./vm/${name}`), 'utf8')]))
  const env: Record<string, string> = {}
  for (const [name, source] of Object.entries(scripts)) {
    env[`ORCA_VM_SCRIPT_${name.replaceAll(/[-.]/g, '_')}`] = Buffer.from(source, 'utf8').toString('base64')
  }
  const install = [
    'set -euo pipefail',
    `for name in ${VM_SCRIPTS.join(' ')}; do`,
    '  var="ORCA_VM_SCRIPT_${name//[-.]/_}"',
    '  printf "%s" "${!var}" | base64 -d | sudo tee "/opt/orca/bin/$name" >/dev/null',
    '  sudo chmod 0755 "/opt/orca/bin/$name"',
    'done',
    'sudo install -m 0644 /opt/orca/bin/orca-session-env.sh /etc/profile.d/zz-orca-session-env.sh',
    '/opt/orca/bin/orca-image-wipe'
  ].join('\n')
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, base, envTag, scripts: Object.keys(scripts) }))
    return
  }
  const api = createVercelSandboxApi({
    token: process.env.VERCEL_TOKEN!,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!
  })
  const name = `orca-golden-patch-${Date.now().toString(36)}`
  const started = Date.now()
  const state = await api.createSandbox({
    name,
    snapshotId: base,
    vcpus: 2,
    region: 'iad1',
    timeoutMs: 10 * 60_000,
    ports: [],
    networkPolicy: { allow: { 'registry.npmjs.org': [] } },
    snapshotExpirationMs: 0,
    tags: { orcaGoldenPatch: '1', orcaEnv: envTag }
  })
  try {
    const result = await api.runCommand(state.session.id, { command: 'bash', args: ['-c', install], env, timeoutMs: 120_000 })
    if (result.exitCode !== 0) {
      throw new Error(`install failed: ${result.stderr.slice(-2000)}`)
    }
    const snapshotId = await api.createSnapshot(state.session.id, 0)
    console.log(JSON.stringify({ snapshotId, base, seconds: Math.round((Date.now() - started) / 1000) }))
  } finally {
    await api.deleteBuildSandbox(name).catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
