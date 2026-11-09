// Finds and removes anything an eval run left behind: ledger sandboxes not marked destroyed (deleted at
// Vercel with their snapshots) and Stripe test customers. Only ids from eval ledgers are touched.
//   tsx src/sweep.ts [--dry-run]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vercel } from './clients'
import { config } from './env'
import { loadRuns } from './run-state'
import { stripe } from './stripe'

const dry = process.argv.includes('--dry-run')
const api = vercel()
for (const run of loadRuns()) {
  let changed = false
  for (const r of run.resources.filter((x) => !x.destroyedAt)) {
    if (r.kind === 'sandbox') {
      const name = r.id.startsWith('orca-') ? r.id : `orca-dev-${r.id}`
      const live = await api.getSandbox(name, { resume: false }).catch(() => null)
      const snaps = (await api.listSnapshots(name).catch(() => [])).filter((s) => s.status === 'created')
      console.log(`${run.runId} sandbox ${name}: ${live ? live.session.status : 'gone'}, ${snaps.length} snapshots`)
      if (!dry) {
        await api.deleteSandbox(name)
        for (const s of snaps) {
          await api.deleteSnapshot(s.id)
        }
        r.destroyedAt = new Date().toISOString()
        r.label = `${r.label ?? ''} [swept]`
        changed = true
      }
    } else if (r.kind === 'stripe_customer') {
      console.log(`${run.runId} stripe customer ${r.id}`)
      if (!dry) {
        await stripe('DELETE', `/v1/customers/${r.id}`).catch(() => {})
        r.destroyedAt = new Date().toISOString()
        changed = true
      }
    }
  }
  if (changed) {
    writeFileSync(join(config.runsDir, `${run.runId}.json`), JSON.stringify(run, null, 2))
  }
}
