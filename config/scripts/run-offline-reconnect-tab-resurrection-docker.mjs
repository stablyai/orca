#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

// Runs the GAP-03 (revive_labs#962 / stablyai/orca#22038) offline-reconnect tab resurrection
// harness: a two-launch Electron test that pairs a client to a Dockerized SSH host, opens N
// terminal tabs, quits the client, closes every one of those tabs "server-side" while it is
// offline, relaunches the client, and measures whether the closed tabs resurrect.
//
// Modeled directly on run-ssh-docker-e2e.mjs: same pnpm/Playwright invocation shape, same
// ORCA_E2E_SSH_DOCKER env-gate the target spec reads to skip itself outside a Docker-capable host.
//
// ORCA_GAP03_TAB_COUNT and ORCA_GAP03_CLOSE_COUNT tune the repro's N/M without editing the spec.
// Left unset here so the spec's own defaults (TAB_COUNT=2, CLOSE_COUNT=TAB_COUNT, i.e. every
// opened tab closes) apply — GAP-03's fix is an all-or-nothing repair (see the spec's own doc
// comment on CLOSE_COUNT), so a run that leaves any survivor tab in the worktree never exercises
// the regression at all, pre- or post-fix.
const rawExtraArgs = process.argv.slice(2)
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1',
  ...(process.env.ORCA_GAP03_TAB_COUNT
    ? { ORCA_GAP03_TAB_COUNT: process.env.ORCA_GAP03_TAB_COUNT }
    : {}),
  ...(process.env.ORCA_GAP03_CLOSE_COUNT
    ? { ORCA_GAP03_CLOSE_COUNT: process.env.ORCA_GAP03_CLOSE_COUNT }
    : {})
}

// Why: Node's CVE-2024-27980 hardening rejects .cmd spawns without shell on Windows.
const spawnOptions = {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
}

const runtime = spawnSync(pnpm, ['run', 'ensure:electron-runtime'], spawnOptions)

if (runtime.status !== 0) {
  process.exit(runtime.status ?? 1)
}

const result = spawnSync(
  pnpm,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/gap-03-offline-reconnect-tab-resurrection.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...extraArgs
  ],
  spawnOptions
)

process.exit(result.status ?? 1)
