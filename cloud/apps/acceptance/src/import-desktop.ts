// Folds a desktop run (desktop/run-desktop.mjs results.json) into acceptance-runs/ as a RunFile so the
// report shows UI evidence (screenshots) and the desktop-measured benchmarks.
//   tsx src/import-desktop.ts <desktop artifacts dir>
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { config } from './env'
import type { CheckResult, RunFile } from './run-state'

const dir = process.argv[2]!
const d = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
/** Desktop step ids -> catalog ids (the desktop's sleep/wake row is UI evidence for the same feature). */
const MAP: Record<string, string> = {
  'cli.desktop': 'cli.desktop',
  'acc.port-forward': 'acc.port-forward',
  'acc.ssh': 'acc.ssh',
  'life.transfer-local': 'life.transfer-local',
  // #127 desktop fixes and the delete paths: desktop-only catalog rows.
  'auth.signed-out-create': 'cli.desktop-signin',
  'proj.cloud-name': 'cli.desktop-project-name',
  'life.destroy': 'cli.desktop-delete',
  'life.delete-unconfirmed': 'cli.desktop-delete-unconfirmed',
  'life.delete-after-oob-destroy': 'cli.desktop-delete-gone',
  'auth.picker-sign-in': 'cli.desktop-picker-signin',
  'life.delete-asleep': 'cli.desktop-delete-asleep',
  'life.delete-asleep-after-move': 'cli.desktop-delete-asleep-moved',
  'life.move-then-delete': 'cli.desktop-move-then-delete',
  'life.auto-resume': 'life.auto-resume',
  'acc.download': 'acc.download',
  'acc.remote-desktop': 'acc.remote-desktop',
  'local.core-workflow': 'local.core-workflow'
}
const checks: CheckResult[] = []
const benchmarks: RunFile['benchmarks'] = []
const samples = (v: any): number[] | null => (v && Array.isArray(v.samples) ? v.samples : null)

for (const s of d.steps ?? []) {
  const flat: Record<string, number> = {}
  for (const [k, v] of Object.entries(s.timings ?? {})) {
    if (typeof v === 'number') {
      flat[k] = v
    } else if (samples(v)) {
      flat[`${k}.p50`] = (v as any).p50
    }
  }
  const id = MAP[s.id]
  if (id) {
    checks.push({
      id,
      status: s.status,
      detail: `Desktop app (Electron, real UI): ${s.detail}`,
      evidence: (s.screenshots ?? []).map((p: string) => ({ kind: 'screenshot' as const, label: basename(p), path: join(dir, p) })),
      timingsMs: flat,
      startedAt: s.startedAt ?? d.startedAt,
      durationMs: s.durationMs ?? 0
    })
  }
  const t = s.timings ?? {}
  if (s.id === 'term.keystroke' && samples(t.keystrokeToEchoMs)) {
    benchmarks.push({ name: 'keystroke.echo', samplesMs: samples(t.keystrokeToEchoMs)!, note: 'desktop xterm: keydown -> char in DOM, warm connection' })
  }
  if (s.id === 'life.sleep-wake' && samples(t.wakeToFirstEchoMs)) {
    benchmarks.push({ name: 'wake.firstKeystroke', samplesMs: samples(t.wakeToFirstEchoMs)!, note: 'desktop: open slept workspace -> first typed char echoed in xterm' })
  }
  if (s.id === 'acc.port-forward' && samples(t.httpGetMs)) {
    benchmarks.push({ name: 'port.forward', samplesMs: samples(t.httpGetMs)!, note: 'GET localhost:4173 forwarded by the desktop to the VM (Mac -> iad1)' })
  }
  if (s.id === 'cli.desktop' && typeof t.createToFirstTerminalOutputMs === 'number') {
    benchmarks.push({ name: 'desktop.createToTerminal', samplesMs: [t.createToFirstTerminalOutputMs], note: 'desktop: click Create -> first terminal output (n=1 per desktop run)' })
  }
}

const runId = `desktop-${basename(dir).replace(/^desktop-/, '')}`
const run: RunFile = {
  runId,
  startedAt: d.startedAt,
  finishedAt: d.finishedAt,
  target: { controlPlaneUrl: d.sandboxUrl, billingUrl: config.billingUrl, desktopRef: `${d.branch}@${String(d.gitHead).slice(0, 11)}` },
  checks,
  benchmarks,
  resources: [],
  notes: [`desktop account ${d.account}; cleanup: ${JSON.stringify(d.cleanup).slice(0, 300)}`, ...(d.notes ?? []), ...(d.bugs ?? []).map((b: any) => `bug (${b.step}): ${b.title}`)]
}
writeFileSync(join(config.runsDir, `${runId}.json`), JSON.stringify(run, null, 2))
console.log(`imported ${checks.length} checks, ${benchmarks.length} benchmarks -> ${runId}.json`)
