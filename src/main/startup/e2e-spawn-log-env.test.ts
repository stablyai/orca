import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { E2E_SPAWN_LOG_ENV } from '@orca/process-host/spawn-observer'
import { dropE2eSpawnLogOutsideE2e } from './e2e-spawn-log-env'

const saved = { log: process.env[E2E_SPAWN_LOG_ENV], userData: process.env.ORCA_E2E_USER_DATA_DIR }

afterEach(() => {
  for (const [key, value] of [
    [E2E_SPAWN_LOG_ENV, saved.log],
    ['ORCA_E2E_USER_DATA_DIR', saved.userData]
  ] as const) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

it('drops the spawn log outside e2e mode, so a spawn writes nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-spawn-log-drop-'))
  const log = path.join(dir, 'spawns.jsonl')
  try {
    delete process.env.ORCA_E2E_USER_DATA_DIR
    process.env[E2E_SPAWN_LOG_ENV] = log
    dropE2eSpawnLogOutsideE2e()
    expect(process.env[E2E_SPAWN_LOG_ENV]).toBeUndefined()
    await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(existsSync(log)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps it in e2e mode', () => {
  process.env.ORCA_E2E_USER_DATA_DIR = '/tmp/orca-e2e-user-data'
  process.env[E2E_SPAWN_LOG_ENV] = '/tmp/spawns.jsonl'
  dropE2eSpawnLogOutsideE2e()
  expect(process.env[E2E_SPAWN_LOG_ENV]).toBe('/tmp/spawns.jsonl')
})
