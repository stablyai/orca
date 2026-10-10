const state = { environment: 'production', window: 360, snapshot: null, config: null, loading: false }

const $ = (selector) => document.querySelector(selector)
const all = (selector) => [...document.querySelectorAll(selector)]
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
})[character])

function formatNumber(value, maximumFractionDigits = 0) {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en-US', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits }).format(value)
}

function formatBytes(value) {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (Math.abs(amount) >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1 }
  return `${formatNumber(amount, amount < 10 ? 1 : 0)} ${units[unit]}`
}

function formatMetric(metric, value) {
  if (value === null || value === undefined) return '—'
  if (metric.unit === 'bytes') return formatBytes(value)
  if (metric.unit === 'milliseconds') return `${formatNumber(value, 1)} ms`
  return formatNumber(value, value < 10 ? 1 : 0)
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function shortImage(value) {
  const digest = value?.match(/sha256:([a-f0-9]{64})/)?.[1]
  if (digest) return digest.slice(0, 10)
  const tag = value?.split(':').at(-1)
  return tag?.slice(0, 16) ?? '—'
}

function badge(label, healthy) {
  return `<span class="badge ${healthy === true ? 'healthy' : healthy === false ? 'unhealthy' : ''}">${escapeHtml(label)}</span>`
}

function renderSummary(snapshot) {
  const { summary } = snapshot
  const utilization = summary.poweredCapacity === null
    ? null
    : summary.poweredCapacity > 0
    ? summary.observedConnections / summary.poweredCapacity * 100
    : 0
  const items = [
    ['Observed connections', formatNumber(summary.observedConnections, 1), 'Latest 1-minute aggregate mean'],
    ['Active relay sessions', formatNumber(summary.observedSplices, 1), `${formatNumber(summary.observedControls, 1)} desktop-control mean`],
    ['Healthy cells', `${summary.activeCells ?? '—'} / ${summary.totalCells}`, summary.poweredCapacity === null ? 'Cell inventory unavailable' : `${formatNumber(summary.poweredCapacity)} powered request units`],
    ['Capacity signal', utilization === null ? '—' : `${formatNumber(utilization, 2)}%`, `${formatNumber(summary.configuredCapacity)} configured admission units`]
  ]
  $('#summary').innerHTML = items.map(([label, value, caption]) => `
    <article class="metric-card">
      <p class="eyebrow">${escapeHtml(label)}</p>
      <div class="value">${escapeHtml(value)}</div>
      <div class="caption">${escapeHtml(caption)}</div>
    </article>`).join('')
}

function cellState(cell) {
  if (cell.targetSize === null) return ['Unknown', null]
  if (cell.targetSize === 0) return ['Sleeping', null]
  if (cell.backendHealth === 'healthy' && cell.endpoint.ready) return ['Healthy', true]
  if (cell.stable && cell.backendHealth === 'empty') return ['Starting', null]
  return ['Attention', false]
}

function renderTopology(snapshot) {
  const director = snapshot.resources.director
  const sleeping = snapshot.resources.cells.every((cell) => cell.targetSize === 0)
    && snapshot.resources.sql?.activationPolicy === 'NEVER'
  const directorHealthy = director?.ready && snapshot.resources.directorEndpoint.health
  $('#topology-meta').textContent = `${snapshot.environment.project} · ${snapshot.environment.region}`
  const cellNodes = snapshot.resources.cells.map((cell) => {
    const [label, healthy] = cellState(cell)
    return `<div class="topology-node">
      <strong>${escapeHtml(cell.hostname.toUpperCase())} ${badge(label, healthy)}</strong>
      <span>${escapeHtml(cell.region)} · ${escapeHtml(cell.zone)} · ${formatNumber(cell.capacityRequests)} units</span>
    </div>`
  }).join('')
  $('#topology').innerHTML = `
    <div class="topology-node"><strong>Desktop + phone</strong><span>Encrypted Relay traffic</span></div>
    <div class="connector" aria-hidden="true"></div>
    <div class="topology-node"><strong>Director ${badge(sleeping ? 'Sleeping' : directorHealthy ? 'Ready' : 'Attention', sleeping ? null : Boolean(directorHealthy))}</strong><span>${escapeHtml(snapshot.environment.directorOrigin)}</span></div>
    <div class="connector" aria-hidden="true"></div>
    <div class="topology-cells">${cellNodes}</div>`
}

function chartPaths(points, width = 400, height = 112) {
  if (points.length === 0) return null
  const values = points.map((point) => point.value)
  const minimum = Math.min(0, ...values)
  const maximum = Math.max(...values)
  const spread = maximum - minimum || 1
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? width : index / (points.length - 1) * width
    const y = height - ((point.value - minimum) / spread * (height - 10) + 5)
    return [x, y]
  })
  const line = coordinates.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  return { line, area }
}

function renderCharts(snapshot) {
  const names = ['controls', 'splices', 'assignment_5xx', 'postgres_retries', 'auth_failures', 'event_loop_ms_p99']
  $('#charts').innerHTML = names.map((name) => {
    const metric = snapshot.monitoring.metrics[name]
    const paths = chartPaths(metric.points)
    const graph = paths ? `<svg class="chart" viewBox="0 0 400 112" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(metric.label)} over time">
      <line x1="0" y1="111" x2="400" y2="111"></line>
      <path class="area" d="${paths.area}"></path><path class="line" d="${paths.line}"></path>
    </svg>` : '<div class="chart-empty">No samples in this window</div>'
    return `<article class="panel chart-card"><div class="chart-head"><div><p class="eyebrow">${escapeHtml(metric.label)}</p><div class="chart-value">${escapeHtml(formatMetric(metric, metric.latest))}</div></div><span class="chart-unit">${escapeHtml(metric.unit)}</span></div>${graph}</article>`
  }).join('')
}

function renderCells(snapshot) {
  const controlsByCell = snapshot.monitoring.metrics.controls.latestByCell
  const splicesByCell = snapshot.monitoring.metrics.splices.latestByCell
  $('#cells').innerHTML = snapshot.resources.cells.map((cell) => {
    const [label, healthy] = cellState(cell)
    const observed = (controlsByCell[cell.cellId] ?? 0) + (splicesByCell[cell.cellId] ?? 0)
    return `<tr>
      <td><strong>${escapeHtml(cell.hostname.toUpperCase())}</strong><div class="row-caption">${escapeHtml(cell.region)} · ${escapeHtml(cell.zone)}</div></td>
      <td>${badge(label, healthy)}<div class="row-caption">MIG ${cell.runningInstances ?? '—'}/${cell.targetSize ?? '—'}</div></td>
      <td>${formatNumber(observed, 1)}<div class="row-caption">1-minute mean</div></td>
      <td>${formatNumber(cell.capacityRequests)}<div class="row-caption">DB pool ${formatNumber(cell.databasePoolMax)} · ${cell.configuredAdmission ? 'configured' : 'candidate only'}</div></td>
      <td class="mono">${escapeHtml(shortImage(cell.imageDigest))}</td>
    </tr>`
  }).join('')
}

function serviceRow(name, healthy, detail, suffix = '') {
  return `<div class="service-row"><div><div class="row-title">${escapeHtml(name)}</div><div class="row-caption">${escapeHtml(detail)}</div></div>${badge(suffix || (healthy ? 'Ready' : 'Attention'), healthy)}</div>`
}

function renderServices(snapshot) {
  const { resources } = snapshot
  const sleeping = resources.cells.every((cell) => cell.targetSize === 0)
    && resources.sql?.activationPolicy === 'NEVER'
  const certDays = resources.certificate?.expireTime
    ? Math.floor((Date.parse(resources.certificate.expireTime) - Date.now()) / 86400000)
    : null
  $('#services').innerHTML = [
    serviceRow('Director', sleeping ? null : Boolean(resources.director?.ready && resources.directorEndpoint.health), `${resources.director?.revision ?? 'Revision unavailable'} · ${shortImage(resources.director?.image)}`, sleeping ? 'Sleeping' : ''),
    serviceRow('Authentication', sleeping ? null : Boolean(resources.auth?.ready && resources.authEndpoint.health), `${resources.auth?.revision ?? 'Revision unavailable'} · ${shortImage(resources.auth?.image)}`, sleeping ? 'Sleeping' : ''),
    serviceRow('Cloud SQL', resources.sql?.state === 'RUNNABLE' || resources.sql?.activationPolicy === 'NEVER', `${resources.sql?.tier ?? 'unknown'} · ${resources.sql?.activationPolicy ?? 'unknown'}`, resources.sql?.state ?? 'Unknown'),
    serviceRow('Wildcard TLS', resources.certificate?.state === 'ACTIVE', resources.certificate?.domains.join(', ') ?? 'Certificate unavailable', certDays === null ? 'Unknown' : `${certDays}d`)
  ].join('')
}

function renderAlerts(snapshot) {
  const policies = snapshot.monitoring.alertPolicies
  $('#alerts').innerHTML = policies.length ? policies.map((policy) => `<div class="list-row"><div><div class="row-title">${escapeHtml(policy.displayName.replace('Orca Relay: ', ''))}</div><div class="row-caption">Cloud Monitoring policy</div></div>${badge(policy.enabled ? 'Enabled' : 'Disabled', policy.enabled)}</div>`).join('') : '<p class="muted">No Relay alert policies returned.</p>'
}

function renderWorkflows(snapshot) {
  $('#workflows').innerHTML = snapshot.workflows.length ? snapshot.workflows.slice(0, 6).map((run) => {
    const healthy = run.conclusion === 'success'
    const stateLabel = run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
    return `<a class="list-row" href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer"><div><div class="row-title">${escapeHtml(run.name)}</div><div class="row-caption">${escapeHtml(run.headSha)} · ${timeAgo(run.updatedAt)}</div></div>${badge(stateLabel, healthy)}</a>`
  }).join('') : '<p class="muted">Workflow history unavailable.</p>'
}

function renderCost(snapshot) {
  const cost = snapshot.cost
  $('#cost').innerHTML = `<div class="cost-total"><strong>$${formatNumber(cost.monthlyUsd)}</strong><span class="muted">/ month</span></div>
    <p class="row-caption">Modeled range $${formatNumber(cost.rangeUsd[0])}–$${formatNumber(cost.rangeUsd[1])}. Not billed cost.</p>
    <div class="cost-lines">${cost.lines.map((line) => `<div class="cost-line"><span>${escapeHtml(line.label)}</span><strong>$${formatNumber(line.monthlyUsd, 2)}</strong></div>`).join('')}</div>
    <p class="cost-note"><strong>Exact billing:</strong> ${escapeHtml(cost.actualBilling.reason)}<br>${escapeHtml(cost.caveats[1])}</p>`
}

function renderWarnings(snapshot) {
  const warning = $('#warnings')
  warning.classList.toggle('hidden', snapshot.warnings.length === 0)
  warning.textContent = snapshot.warnings.length ? `Partial data: ${snapshot.warnings.join(' ')}` : ''
}

function render(snapshot) {
  state.snapshot = snapshot
  $('#environment-label').textContent = `${snapshot.environment.label} · ${snapshot.environment.region}`
  $('#freshness').textContent = snapshot.stale
    ? `Last good update ${timeAgo(snapshot.generatedAt)} · refresh degraded`
    : `Updated ${timeAgo(snapshot.generatedAt)}`
  $('#freshness-dot').className = snapshot.stale ? 'status-dot neutral' : 'status-dot healthy'
  renderWarnings(snapshot)
  renderSummary(snapshot)
  renderTopology(snapshot)
  renderCharts(snapshot)
  renderCells(snapshot)
  renderServices(snapshot)
  renderAlerts(snapshot)
  renderWorkflows(snapshot)
  renderCost(snapshot)
  $('#power-panel').classList.toggle('hidden', !(state.environment === 'staging' && state.config?.stagingControlsEnabled))
  $('#compute-link').href = snapshot.environment.consoleLinks.compute
  $('#alert-link').href = snapshot.environment.consoleLinks.alerts
}

async function loadSnapshot() {
  if (state.loading) return
  state.loading = true
  $('#refresh').disabled = true
  $('#error').classList.add('hidden')
  $('#freshness-dot').className = 'status-dot neutral'
  $('#freshness').textContent = 'Refreshing current state…'
  try {
    const response = await fetch(`/api/snapshot?environment=${state.environment}&window=${state.window}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Snapshot failed')
    render(body)
  } catch (error) {
    $('#freshness-dot').className = 'status-dot unhealthy'
    $('#freshness').textContent = 'Refresh failed'
    $('#error').textContent = error instanceof Error ? error.message : 'Relay operations data is unavailable.'
    $('#error').classList.remove('hidden')
  } finally {
    state.loading = false
    $('#refresh').disabled = false
  }
}

async function dispatchPower(mode) {
  const confirmation = mode === 'wake' ? 'WAKE_STAGING' : mode === 'sleep' ? 'SLEEP_STAGING' : ''
  if (confirmation) {
    const entered = window.prompt(`Type ${confirmation} to dispatch the guarded workflow.`) ?? ''
    if (entered !== confirmation) return
  }
  all('[data-power]').forEach((button) => { button.disabled = true })
  $('#power-result').textContent = 'Dispatching…'
  try {
    const response = await fetch('/api/staging/power', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': state.config.csrfToken },
      body: JSON.stringify({ mode, confirmation })
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    $('#power-result').textContent = 'Workflow accepted. Refresh after it completes.'
  } catch (error) {
    $('#power-result').textContent = error instanceof Error ? error.message : 'Dispatch failed.'
  } finally {
    all('[data-power]').forEach((button) => { button.disabled = false })
  }
}

all('[data-environment]').forEach((button) => button.addEventListener('click', () => {
  state.environment = button.dataset.environment
  all('[data-environment]').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)))
  loadSnapshot()
}))
$('#window').addEventListener('change', (event) => { state.window = Number(event.target.value); loadSnapshot() })
$('#refresh').addEventListener('click', loadSnapshot)
all('[data-power]').forEach((button) => button.addEventListener('click', () => dispatchPower(button.dataset.power)))

async function start() {
  try { state.config = await fetch('/api/config').then((response) => response.json()) } catch { state.config = {} }
  await loadSnapshot()
  window.setInterval(loadSnapshot, 60_000)
}

start()
