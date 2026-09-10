#!/usr/bin/env node
// Why this exists: run-maestro-live-probe.mjs is a validator. It spawns
// targets.runtime_probe.command and validates that command's stdout against the
// ORC-11P contract. Nothing produced that artifact, so ORC-12 could not run at all.
// This driver is that missing producer. It launches the REAL unpacked Orca from
// dist/linux-unpacked under an isolated user-data directory, composes the probe out
// of the packaged Maestro CLI commands, observes identities rather than accepting
// declared ones, captures its own evidence, stops everything it started, and prints
// the artifact on stdout. Stage narration goes to stderr so stdout stays pure JSON.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const REPO_ROOT = process.env.ORCA_PROBE_REPO_ROOT ?? process.cwd()
const UNPACKED = join(REPO_ROOT, 'dist', 'linux-unpacked')
const ORCA_BIN = join(UNPACKED, 'orca-ide')
const ORCA_CLI = join(UNPACKED, 'resources', 'bin', 'orca-ide')
// Why a short path: the daemon binds a Unix socket under the user-data directory and
// a long prefix overflows sun_path, which fails as EINVAL during daemon startup.
const PROBE_ROOT = process.env.ORCA_PROBE_HOME ?? `/tmp/orca-probe-${process.pid}`
const USER_DATA = join(PROBE_ROOT, 'chromium')
const PROBE_REPO = process.env.ORCA_PROBE_TARGET_REPO ?? ''

const stages = []
const owned = {
  processes: new Set(),
  browserPages: new Set(),
  worktrees: new Set(),
  leases: new Set()
}

function note(message) {
  process.stderr.write(`[probe] ${message}\n`)
}

function record(stage, status, detail = {}) {
  stages.push({ stage, status, ...detail })
  note(`${stage}: ${status}${detail.reason ? ` — ${detail.reason}` : ''}`)
}

function cli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      ORCA_CLI,
      [...args, '--json'],
      {
        cwd: REPO_ROOT,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ORCA_USER_DATA_PATH: USER_DATA }
      },
      (error, stdout, stderr) => {
        let parsed = null
        try {
          parsed = JSON.parse(stdout)
        } catch {
          parsed = null
        }
        resolve({
          ok: parsed?.ok === true,
          parsed,
          stdout,
          stderr,
          error: error ? String(error) : null
        })
      }
    )
  })
}

async function launchOrca() {
  mkdirSync(USER_DATA, { recursive: true })
  const child = spawn(ORCA_BIN, [`--user-data-dir=${USER_DATA}`, '--no-sandbox'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCA_USER_DATA_PATH: USER_DATA }
  })
  owned.processes.add(child.pid)
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))
  child.unref()
  const metadataPath = join(USER_DATA, 'orca-runtime.json')
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (existsSync(metadataPath)) {
      const probe = await cli(['maestro', 'index'])
      if (probe.ok) {
        return { pid: child.pid, runtimeId: probe.parsed?._meta?.runtimeId ?? null, log }
      }
    }
    await delay(1500)
  }
  throw new Error('isolated Orca runtime did not become reachable within 120s')
}

/** Every identity below is read back from the live runtime, never taken from the caller. */
async function discoverIdentities() {
  const hosts = await cli(['host', 'list'])
  if (!hosts.ok) {
    throw new Error(`host list failed: ${hosts.stdout || hosts.error}`)
  }
  const executionHostId = hosts.parsed.result.hosts.find((host) => host.kind === 'local')?.id
  if (!executionHostId) {
    throw new Error('no local execution host reported')
  }
  if (PROBE_REPO) {
    await cli(['repo', 'add', '--path', PROBE_REPO])
  }
  const worktrees = await cli(['worktree', 'list'])
  if (!worktrees.ok) {
    throw new Error(`worktree list failed: ${worktrees.stdout || worktrees.error}`)
  }
  const match = worktrees.parsed.result.worktrees.find(
    (worktree) => !PROBE_REPO || worktree.path === PROBE_REPO
  )
  if (!match) {
    throw new Error('probe workspace is not registered on the isolated runtime')
  }
  return {
    execution_host_id: executionHostId,
    workspace_key: `worktree:${match.id}`,
    worktree_id: match.id,
    worktree_path: match.path,
    worktree_head: match.head,
    project_id: match.projectId ?? null
  }
}

async function createRun(identities, coordinatorHandle) {
  const created = await cli([
    'orchestration',
    'run-create',
    '--objective',
    'ORC-12 real isolated probe',
    '--from',
    coordinatorHandle
  ])
  if (!created.ok) {
    return { ok: false, reason: created.parsed?.error?.message ?? created.stdout }
  }
  return { ok: true, run: created.parsed.result.run }
}

async function createTerminal(identities, title) {
  const created = await cli([
    'terminal',
    'create',
    '--worktree',
    `id:${identities.worktree_id}`,
    '--title',
    title
  ])
  if (!created.ok) {
    return { ok: false, reason: created.parsed?.error?.message ?? created.stdout }
  }
  return { ok: true, terminal: created.parsed.result.terminal }
}

/**
 * Why this is expected to fail today: browser surfaces, delegation, notes and every
 * other Maestro mutation resolve their principal from the calling terminal's agent
 * authority. A terminal created by `orca terminal create` is a plain shell with no
 * launch token, so the runtime refuses it as a coordinator. The probe still attempts
 * it and records the exact refusal rather than skipping the clause silently.
 */
async function probeCoordinatorAuthority(identities, run, coordinatorHandle) {
  const payload = {
    schema_version: 1,
    protocol: 'maestro-browser-surface/v1',
    request_id: `orc12-surface-${Date.now()}`,
    workspace: {
      repository_id: identities.worktree_id.split('::')[0],
      execution_host_id: identities.execution_host_id,
      workspace_key: identities.workspace_key,
      run_id: run.id
    },
    actor: {
      actor_id: coordinatorHandle,
      kind: 'coordinator',
      authenticated: true,
      session_id: `orc12-session-${Date.now()}`
    },
    coordinator_generation: run.consumer_generation,
    task_id: 'ORC-12',
    attempt_id: 'attempt-orc-12-002',
    agent_id: 'orc12-probe',
    url: 'https://example.com/',
    title: 'ORC-12 probe surface',
    profile_id: null,
    requested_visibility: 'visible',
    viewport: { width: 1280, height: 720, device_scale_factor: 1 },
    retention: 'release_when_settled',
    ownership: 'harness',
    evidence: {
      route_or_component: 'maestro-canvas',
      state: 'populated',
      theme: 'dark',
      source_revision: 'r17',
      capture_mode: 'native-viewport'
    }
  }
  const opened = await cli([
    'maestro',
    'browser-surface',
    'open',
    '--payload',
    JSON.stringify(payload)
  ])
  if (opened.ok) {
    const receipt = opened.parsed.result
    if (receipt?.browser_page_id) {
      owned.browserPages.add(receipt.browser_page_id)
    }
    return { ok: true, receipt }
  }
  return {
    ok: false,
    reason: opened.parsed?.error?.message ?? opened.stdout,
    error_code: opened.parsed?.error?.code ?? null
  }
}

/** The driver owns its whole tree; nothing it started may outlive it. */
/**
 * Ownership is proved by the probe root, not by process group.
 *
 * Why: Electron reparents its daemon and crashpad handler away from the launcher, and
 * `terminal create` shells are children of that daemon, so killing the launcher's
 * process group leaks all of them. Every one of those processes still carries this
 * run's unique PROBE_ROOT on its command line — user-owned Orca never does — so that
 * string is the ownership test, and it cannot match another instance.
 */
function listProbeOwnedProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,args'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      const self = String(process.pid)
      const rows = []
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) {
          continue
        }
        const [, pid, ppid, args] = match
        if (pid === self || !args.includes(PROBE_ROOT) || args.startsWith('ps -eo')) {
          continue
        }
        rows.push({ pid: Number(pid), ppid: Number(ppid), args })
      }
      resolve(rows)
    })
  })
}

async function stopOwnedTree() {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const rows = await listProbeOwnedProcesses()
    if (rows.length === 0) {
      break
    }
    // Children first: a shell reaped after its daemon cannot be re-adopted mid-sweep.
    for (const row of rows.sort((left, right) => right.ppid - left.ppid)) {
      try {
        process.kill(row.pid, signal)
      } catch {
        // already gone
      }
    }
    await delay(signal === 'SIGTERM' ? 5000 : 2000)
  }
  const survivors = await listProbeOwnedProcesses()
  return survivors.map((row) => row.pid)
}

function countLiveUnpackedProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,args'], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const lines = stdout
        .split('\n')
        .filter((line) => line.includes(UNPACKED) && !line.includes('ps -eo'))
      resolve(lines.length)
    })
  })
}

async function main() {
  const startedAt = Date.now()
  let identities = null
  let launch = null

  try {
    launch = await launchOrca()
    record('launch_isolated_orca', 'observed', { pid: launch.pid, runtime_id: launch.runtimeId })
  } catch (error) {
    record('launch_isolated_orca', 'unmet', { reason: String(error) })
  }

  if (launch) {
    try {
      identities = await discoverIdentities()
      record('discover_identities', 'observed', identities)
    } catch (error) {
      record('discover_identities', 'unmet', { reason: String(error) })
    }
  }

  let run = null
  let coordinator = null
  let worker = null
  let authority = null

  if (identities) {
    const created = await createTerminal(identities, 'orc12-coordinator')
    if (created.ok) {
      coordinator = created.terminal
      record('named_coordinator_terminal', 'observed', {
        handle: coordinator.handle,
        pane_key: coordinator.paneKey,
        title: coordinator.title,
        surface: coordinator.surface
      })
    } else {
      record('named_coordinator_terminal', 'unmet', { reason: created.reason })
    }
  }

  if (coordinator) {
    const createdWorker = await createTerminal(identities, 'orc12-worker')
    if (createdWorker.ok) {
      worker = createdWorker.terminal
      record('named_worker_terminal', 'observed', {
        handle: worker.handle,
        pane_key: worker.paneKey,
        title: worker.title
      })
    } else {
      record('named_worker_terminal', 'unmet', { reason: createdWorker.reason })
    }
  }

  if (coordinator) {
    const createdRun = await createRun(identities, coordinator.handle)
    if (createdRun.ok) {
      run = createdRun.run
      record('run_bound_to_coordinator', 'observed', {
        run_id: run.id,
        coordinator_handle: run.coordinator_handle,
        coordinator_pane_key: run.coordinator_pane_key,
        consumer_generation: run.consumer_generation
      })
    } else {
      record('run_bound_to_coordinator', 'unmet', { reason: createdRun.reason })
    }
  }

  if (run && coordinator) {
    authority = await probeCoordinatorAuthority(identities, run, coordinator.handle)
    record('coordinator_authority_for_maestro_mutations', authority.ok ? 'observed' : 'unmet', {
      reason: authority.ok ? null : authority.reason,
      error_code: authority.ok ? null : authority.error_code
    })
  }

  // Every clause below depends on authenticated coordinator authority, which a plain
  // `terminal create` shell cannot hold. They are named so absence is never read as success.
  const authorityGated = [
    'coordinator_handoff',
    'bounded_progress_stream',
    'navigator_digest',
    'child_worktree_delegation',
    'pinned_note_revision',
    'visible_native_browser_surface',
    'visual_evidence_capture',
    'canonical_progress_transitions',
    'three_serial_probe_tasks',
    'retain_across_restart',
    'context_exhaustion_and_profile_drift',
    'coordinator_kill_takeover_reconcile',
    'release_and_retire_created_resources'
  ]
  for (const stage of authorityGated) {
    record(stage, 'unmet', {
      reason: authority?.ok
        ? 'not driven by this driver revision'
        : 'blocked: no authenticated coordinator agent session is obtainable through the packaged CLI'
    })
  }

  const survivors = await stopOwnedTree()
  record(
    survivors.length === 0 ? 'stop_owned_tree' : 'stop_owned_tree_incomplete',
    survivors.length === 0 ? 'observed' : 'unmet',
    survivors.length === 0 ? {} : { reason: `pids still alive: ${survivors.join(',')}` }
  )
  const liveUnpacked = await countLiveUnpackedProcesses()

  const artifact = {
    schema_version: 1,
    task_id: 'ORC-11P',
    driver: 'config/scripts/run-maestro-live-probe-driver.mjs',
    driver_revision: 'attempt-orc-12-002',
    completeness: 'partial',
    execution_workspace: identities
      ? { workspace_key: identities.workspace_key, execution_host_id: identities.execution_host_id }
      : null,
    observed_identities: identities,
    isolated_profile: { user_data_path: USER_DATA, probe_root: PROBE_ROOT },
    stages,
    visual_evidence: null,
    run: run,
    coordinator_terminal: coordinator,
    worker_terminal: worker,
    cleanup: {
      live_owned_resources: owned.browserPages.size + owned.worktrees.size + owned.leases.size,
      open_browser_pages: owned.browserPages.size,
      open_processes: survivors.length,
      unpacked_processes_observed_after: liveUnpacked,
      user_owned_resources_touched: false,
      unrelated_workspaces_touched: false
    },
    unmet_clauses: stages.filter((stage) => stage.status === 'unmet').map((stage) => stage.stage),
    wall_time_ms: Date.now() - startedAt
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
  return artifact.unmet_clauses.length === 0 ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    note(`fatal: ${error instanceof Error ? error.stack : String(error)}`)
    void stopOwnedTree()
    process.exitCode = 1
  })
