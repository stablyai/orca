import { runProcess } from '@orca/process-host'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('streams requested density, capped fallback frames and CSS-coordinate clicks', async () => {
  const result = await runProcess({
    program: process.execPath,
    args: [resolve('tests/tools/browser-mobile-raster/run.cjs'), '--scale', '3'],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 60_000,
    detached: process.platform !== 'win32',
    maxOutputBytes: 128 * 1024
  })
  expect(result.timedOut, result.stdout + result.stderr).toBe(false)
  expect(result.code, result.stdout + result.stderr).toBe(0)
}, 70_000)
