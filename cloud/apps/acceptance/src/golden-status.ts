// Active dev golden image and whether its source commit contains a given commit.
//   tsx src/golden-status.ts [requiredCommit] [--wait]   (prints one line per check; --wait polls every 2 min)
import { execFileSync } from 'node:child_process'

const required = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
const wait = process.argv.includes('--wait')
const controlDir = new URL('../../sandbox-control/', import.meta.url).pathname

function active(): { snapshot: string; commit: string | null; activatedAt: number } | null {
  const raw = execFileSync(
    `${controlDir}node_modules/.bin/wrangler`,
    ['d1', 'execute', 'SANDBOX_DB', '-c', 'wrangler.dev.jsonc', '--remote', '--json', '--command',
      "SELECT snapshot_id, bundle_sha256, activated_at FROM golden_images WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1"],
    { cwd: controlDir, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }
  )
  const row = (JSON.parse(raw.slice(raw.indexOf('['))) as Array<{ results: any[] }>)[0]?.results[0]
  if (!row) {
    return null
  }
  const commit = String(row.bundle_sha256 ?? '').startsWith('git:') ? String(row.bundle_sha256).slice(4) : null
  return { snapshot: row.snapshot_id, commit, activatedAt: row.activated_at }
}

function contains(commit: string, ancestor: string): boolean {
  try {
    execFileSync('git', ['fetch', '-q', 'private', 'cloud/integration'], { stdio: 'ignore' })
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

for (;;) {
  const a = active()
  const ok = a?.commit && required ? contains(a.commit, required) : null
  console.log(JSON.stringify({ at: new Date().toISOString(), ...a, containsRequired: ok }))
  if (!wait || ok) {
    break
  }
  await new Promise((r) => setTimeout(r, 120_000))
}
