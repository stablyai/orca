// Renders .context/cloud/orca-cloud-evaluation-report.html from every run on disk: the latest
// result per feature (with the run it came from), benchmarks, gaps, cost and the resource ledger.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { CONDUCTOR, EARLIER } from './bench'
import { CATALOG, SECTIONS, type Feature } from './catalog'
import { config } from './env'
import { loadRuns, percentile, type CheckResult, type Resource, type RunFile } from './run-state'

/** Vercel Sandbox list prices (Pro, 2026-11): active CPU per vCPU-hour, memory per GB-hour (2 GB/vCPU). */
const CPU_PER_VCPU_HOUR = 0.128
const MEM_PER_GB_HOUR = 0.0106
const GB_PER_VCPU = 2

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const sec = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`)

const STATUS: Record<string, { cls: string; label: string }> = {
  pass: { cls: 'g', label: '✅ pass' },
  partial: { cls: 'w', label: '⚠️ partial' },
  fail: { cls: 'b', label: '❌ fail' },
  not_landed: { cls: 'n', label: '⏳ not landed' },
  skipped: { cls: 'n', label: '— skipped' }
}

export function resourceCost(rows: Resource[]): { vcpuHours: number; usd: number } {
  let vcpuHours = 0
  for (const r of rows) {
    if (r.kind !== 'sandbox') {
      continue
    }
    const ms = r.runningMs ?? (r.destroyedAt ? Date.parse(r.destroyedAt) - Date.parse(r.createdAt) : 0)
    vcpuHours += ((r.vcpus ?? 4) * ms) / 3_600_000
  }
  // Upper bound: Vercel bills active CPU, so idle time is cheaper than this.
  const usd = vcpuHours * (CPU_PER_VCPU_HOUR + GB_PER_VCPU * MEM_PER_GB_HOUR)
  return { vcpuHours, usd }
}

function latestResults(runs: RunFile[]): Map<string, { result: CheckResult; run: RunFile }> {
  const out = new Map<string, { result: CheckResult; run: RunFile }>()
  for (const run of runs) {
    for (const result of run.checks) {
      out.set(result.id, { result, run })
    }
  }
  return out
}

function evidenceHtml(result: CheckResult, run: RunFile): string {
  const parts: string[] = []
  if (result.timingsMs) {
    parts.push(Object.entries(result.timingsMs).map(([k, v]) => `<code>${esc(k)} ${sec(v)}</code>`).join(' '))
  }
  for (const e of result.evidence) {
    if (e.path) {
      const href = relative(config.contextDir, e.path)
      parts.push(e.kind === 'screenshot' ? `<a href="${esc(href)}"><img src="${esc(href)}" alt="${esc(e.label)}" loading="lazy"></a>` : `<a href="${esc(href)}">${esc(e.label)}</a>`)
    } else if (e.text) {
      parts.push(`<details><summary>${esc(e.label)}</summary><pre>${esc(e.text)}</pre></details>`)
    }
  }
  parts.push(`<span class="small muted">run ${esc(run.runId)} · ${esc(result.startedAt.slice(0, 16).replace('T', ' '))}Z</span>`)
  return parts.join('<br>')
}

function featureRow(f: Feature, hit: { result: CheckResult; run: RunFile } | undefined): string {
  const status = hit?.result.status ?? 'not_landed'
  const s = STATUS[status]!
  const detail = hit ? esc(hit.result.detail) : `No check result yet; waiting on <b>${esc(f.owner)}</b>.`
  return `<tr><th>${esc(f.feature)}<div class="small muted"><code>${esc(f.id)}</code> · ${esc(f.priority)} · ${esc(f.owner)}</div></th>
<td class="${s.cls} c">${s.label}</td><td>${detail}</td><td>${hit ? evidenceHtml(hit.result, hit.run) : ''}</td>
<td>${esc(f.conductor)}</td><td>${f.better ? esc(f.better) : ''}</td></tr>`
}

function benchTable(runs: RunFile[]): string {
  const latest = new Map<string, { samples: number[]; run: RunFile; note?: string }>()
  for (const run of runs) {
    for (const b of run.benchmarks) {
      if (b.samplesMs.length > 0) {
        latest.set(b.name, { samples: b.samplesMs, run, ...(b.note ? { note: b.note } : {}) })
      }
    }
  }
  const names = ['create.api', 'create.usable', 'create.firstEcho', 'wake.api', 'wake.firstEcho', 'suspend.api', 'rollover.gap', 'port.forward', 'share.coldLoad']
  const rows = names.map((name) => {
    const b = latest.get(name)
    const n = b?.samples.length ?? 0
    return `<tr><th><code>${esc(name)}</code></th><td class="c">${n}</td><td class="c ${n >= 10 ? '' : 'w'}">${b ? sec(percentile(b.samples, 50)) : 'pending'}</td>
<td class="c">${b ? sec(percentile(b.samples, 95)) : ''}</td><td class="c">${b ? `${sec(Math.min(...b.samples))} – ${sec(Math.max(...b.samples))}` : ''}</td>
<td>${esc(CONDUCTOR[name] ?? '')}</td><td>${esc(EARLIER[name] ?? '')}</td><td class="small">${b ? `run ${esc(b.run.runId)}${b.note ? `<br>${esc(b.note)}` : ''}` : ''}</td></tr>`
  })
  return `<div class="tablewrap"><table><thead><tr><th>Metric</th><th>n</th><th>p50</th><th>p95</th><th>min – max</th><th>Conductor (documented)</th><th>Our earlier numbers</th><th>Source</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

function ledgerTable(runs: RunFile[]): string {
  const rows = runs.flatMap((run) =>
    run.resources.map(
      (r) => `<tr><td class="c">${esc(run.runId)}</td><td>${esc(r.kind)}</td><td><code>${esc(r.id)}</code></td><td>${esc(r.label ?? '')}</td>
<td class="c">${esc(r.createdAt.slice(11, 19))}</td><td class="c ${r.destroyedAt ? 'g' : 'b'}">${r.destroyedAt ? esc(r.destroyedAt.slice(11, 19)) : 'NOT DESTROYED'}</td></tr>`
    )
  )
  return `<details><summary>${rows.length} resources across ${runs.length} runs</summary><div class="tablewrap"><table><thead><tr><th>Run</th><th>Kind</th><th>Id</th><th>Label</th><th>Created (UTC)</th><th>Destroyed</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></details>`
}

/** Hand-curated findings/gaps (HTML snippets), versioned with the harness: findings.json {findings, gaps}. */
function loadFindings(): { gaps?: string[]; findings?: string[] } {
  const path = new URL('../findings.json', import.meta.url).pathname
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { gaps?: string[]; findings?: string[] }) : {}
}

export function renderReport(): string {
  const extra = loadFindings()
  const runs = loadRuns()
  const latest = latestResults(runs)
  const counts = { pass: 0, partial: 0, fail: 0, not_landed: 0, skipped: 0 }
  for (const f of CATALOG) {
    counts[(latest.get(f.id)?.result.status ?? 'not_landed') as keyof typeof counts]++
  }
  const allResources = runs.flatMap((r) => r.resources)
  const cost = resourceCost(allResources)
  const leaked = allResources.filter((r) => !r.destroyedAt)
  const sections = SECTIONS.map((section) => {
    const rows = CATALOG.filter((f) => f.section === section).map((f) => featureRow(f, latest.get(f.id)))
    return `<tr class="sec"><th colspan="6">${esc(section)}</th></tr>${rows.join('')}`
  }).join('')
  const lastRun = runs.at(-1)
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orca Cloud evaluation report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b636e;--border:#d8dde3;--head:#f3f5f8;--good-bg:#e6f6ea;--good-fg:#145c2a;--warn-bg:#fff5d6;--warn-fg:#6b4e00;--bad-bg:#fde8e8;--bad-fg:#8a1c1c;--na-bg:#eef0f3;--link:#0b5fcc;--code:#f1f3f6}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e3e7ec;--muted:#9aa3ad;--border:#2c333b;--head:#1a1f25;--good-bg:#12301c;--good-fg:#8fe0a6;--warn-bg:#352a0b;--warn-fg:#f2cf6b;--bad-bg:#3a1515;--bad-fg:#f3a3a3;--na-bg:#1d2228;--link:#6aa7ff;--code:#1d2228}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1500px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}
.sub,.muted{color:var(--muted)}a{color:var(--link)}code{background:var(--code);padding:1px 4px;border-radius:3px;font-size:12.5px}
.tablewrap{overflow:auto;max-height:85vh;border:1px solid var(--border);border-radius:6px}table{border-collapse:separate;border-spacing:0;width:100%}
th,td{border-bottom:1px solid var(--border);border-right:1px solid var(--border);padding:7px 9px;vertical-align:top;text-align:left}
thead th{position:sticky;top:0;background:var(--head);z-index:2;font-weight:600}tbody th{background:var(--head);font-weight:600;width:20%}
td.g{background:var(--good-bg);color:var(--good-fg)}td.w{background:var(--warn-bg);color:var(--warn-fg)}td.b{background:var(--bad-bg);color:var(--bad-fg)}td.n{background:var(--na-bg)}
tr.sec th{background:var(--bg);font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.callout{border-left:4px solid var(--link);background:var(--head);padding:10px 14px;border-radius:4px;margin:12px 0}
.small{font-size:12.5px}td.c{white-space:nowrap}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:300px;overflow:auto}
img{max-width:260px;border:1px solid var(--border);border-radius:4px}.kpi span{display:inline-block;padding:2px 8px;border-radius:4px;margin-right:6px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body><main>
<h1>Orca Cloud evaluation report</h1>
<p class="sub">Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}Z by <code>cloud/apps/acceptance</code> (branch <code>cloud/w9-eval</code>) from ${runs.length} run(s) in <code>acceptance-runs/</code>.
Real Vercel Sandbox VMs (team lovecast, Pro, iad1) via the DEV control plane <code>${esc(config.controlPlaneUrl)}</code> and DEV billing <code>${esc(config.billingUrl)}</code>; Stripe TEST mode only.
Parity bar: <a href="conductor-parity-matrix.html">conductor-parity-matrix.html</a>. Each row shows the most recent result for that feature and the run it came from.</p>
<div class="callout kpi"><b>Status (${CATALOG.length} features):</b>
<span class="g" style="background:var(--good-bg);color:var(--good-fg)">✅ ${counts.pass} pass</span>
<span style="background:var(--warn-bg);color:var(--warn-fg)">⚠️ ${counts.partial} partial</span>
<span style="background:var(--bad-bg);color:var(--bad-fg)">❌ ${counts.fail} fail</span>
<span style="background:var(--na-bg)">⏳ ${counts.not_landed} not landed</span>
<span style="background:var(--na-bg)">— ${counts.skipped} skipped</span><br>
<b>Last run:</b> ${lastRun ? `${esc(lastRun.runId)} (${esc(lastRun.startedAt.slice(0, 16))}Z, target ${esc(lastRun.target.integrationSha ?? lastRun.target.desktopRef ?? 'API only')})` : 'none'} ·
<b>Eval cost so far:</b> ≈ $${cost.usd.toFixed(2)} Vercel compute (${cost.vcpuHours.toFixed(2)} vCPU-h, upper bound at list price) · <b>Leaked resources:</b> ${leaked.length === 0 ? '0 ✅' : `<span style="color:var(--bad-fg)">${leaked.length}</span>`}</div>
<h2>Features</h2>
<div class="tablewrap"><table><thead><tr><th>Feature</th><th>Status</th><th>Result</th><th>Evidence</th><th>Conductor</th><th>Better than Conductor</th></tr></thead><tbody>${sections}</tbody></table></div>
<h2>Benchmarks</h2>
<p class="small muted">Nearest-rank percentiles. Definitions: <code>create.api</code> = POST /v1/sandboxes until orcad is ready (golden snapshot boot + private repo clone);
<code>create.usable</code> adds the user's client connecting (orca CLI, E2EE handshake); <code>*.firstEcho</code> adds registering the project, opening a PTY and seeing a typed command echoed
(each CLI call reconnects, so this is an upper bound on what the desktop's warm connection sees); <code>rollover.gap</code> = drain + stop + boot + orcad ready.</p>
${benchTable(runs)}
<h2>Known gaps and findings</h2>
<ul>${[...(extra.findings ?? []), ...(extra.gaps ?? [])].map((g) => `<li>${g}</li>`).join('') || '<li>none recorded</li>'}</ul>
<h2>Cost of the eval and every cloud resource</h2>
<p class="small">Compute estimate = Σ vCPU × running time × ($${CPU_PER_VCPU_HOUR}/vCPU-h + ${GB_PER_VCPU} GB × $${MEM_PER_GB_HOUR}/GB-h). AI Gateway spend is read from <code>/v1/credits</code> when an agent check runs. Stripe objects are test mode (free).</p>
${ledgerTable(runs)}
<h2>How to rerun</h2>
<pre>cd cloud/apps/acceptance
pnpm accept                    # every check + cleanup verification, then this report
pnpm accept --bench --n 10        # + benchmarks (n per metric)
pnpm accept --only sub.tools,life.rollover
pnpm sweep                      # list/destroy anything a crashed run left behind
pnpm report                     # re-render this page from acceptance-runs/*.json</pre>
</main></body></html>`
  writeFileSync(config.reportPath, html)
  return config.reportPath
}
