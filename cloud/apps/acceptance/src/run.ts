// Orca Cloud eval: every parity-matrix feature against real Vercel sandboxes via the DEV control plane.
//   tsx src/run.ts [--only a,b] [--skip a,b] [--bench] [--n 10] [--no-checks] [--sha <integration sha>]
// Always destroys what it created (also on failure/Ctrl-C), verifies nothing is left, renders the report.
import { benchCreate, benchWakeAndRollover } from './bench'
import { CATALOG } from './catalog'
import { agentChecks } from './checks/agents'
import { billingChecks } from './checks/billing'
import { lifecycleChecks } from './checks/lifecycle'
import { platformChecks } from './checks/platform'
import { coreChecks } from './checks/core'
import { opsChecks } from './checks/ops'
import { pendingChecks } from './checks/pending'
import { secretChecks } from './checks/secrets'
import { Ctx, runCheck, type Check } from './context'
import { config } from './env'
import { renderReport } from './report'
import { RunState } from './run-state'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const value = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const only = value('only')?.split(',')
const skip = new Set(value('skip')?.split(',') ?? [])
const n = Number(value('n') ?? 10)

const CHECKS: Record<string, Check> = { ...pendingChecks, ...coreChecks, ...secretChecks, ...opsChecks, ...billingChecks, ...agentChecks, ...lifecycleChecks, ...platformChecks }
/** Checks that change the primary's lifecycle run after the ones that only read it; cleanup is last. */
const LATE = ['billing.teardown', 'ops.kill-switch', 'life.sleep-wake', 'life.rollover', 'ops.cleanup']

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const run = new RunState(runId, {
  controlPlaneUrl: config.controlPlaneUrl,
  billingUrl: config.billingUrl,
  ...(value('sha') ? { integrationSha: value('sha') } : {})
})
const ctx = new Ctx(run)
console.log(`eval run ${runId} -> ${run.path}`)

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) {
    process.exit(130)
  }
  interrupted = true
  console.log('\ninterrupted: cleaning up (Ctrl-C again to abort cleanup)')
})

try {
  if (!flag('no-checks')) {
    const ids = CATALOG.map((f) => f.id).filter((id) => (!only || only.includes(id)) && !skip.has(id) && !LATE.includes(id))
    const late = LATE.filter((id) => (!only || only.includes(id)) && !skip.has(id))
    for (const id of [...ids, ...late]) {
      if (interrupted) {
        break
      }
      const check = CHECKS[id]
      if (check) {
        await runCheck(ctx, id, check)
      }
    }
  }
  if (flag('bench') && !interrupted) {
    await benchCreate(ctx, n)
    await benchWakeAndRollover(ctx, n)
  }
} finally {
  const { failed } = await ctx.sandboxes.destroyAll()
  if (failed.length) {
    run.note(`cleanup failed for ${failed.join(', ')}; run pnpm sweep`)
    console.log(`CLEANUP FAILED: ${failed.join(', ')}`)
  }
  run.finish()
  console.log(`report: ${renderReport()}`)
}
