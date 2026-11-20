import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'

const success = {
  environmentResolved: true,
  code: 0,
  stdout: '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n',
  stderr: '',
  timedOut: false
}

beforeEach(() => {
  runWslProcessMock.mockReset()
})

// Executes the real detection script; Windows has no /bin/sh.
;(process.platform === 'win32' ? it.skip : it)(
  'resolves a tilde executable without changing its inventory identity',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-wsl-detect-'))
    try {
      mkdirSync(join(home, 'custom bin'), { recursive: true })
      const file = join(home, 'custom bin', 'orca-fake-cli')
      writeFileSync(file, '#!/bin/sh\n')
      chmodSync(file, 0o755)
      runWslProcessMock.mockResolvedValue({ ...success, stdout: '' })
      await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['~/custom bin/orca-fake-cli'])
      const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
      const out = execFileSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' }
      })
      expect(out).toBe(`__ORCA_AGENT_PATH__~/custom bin/orca-fake-cli\t${file}\n`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)

describe('strict WSL execution-host admission', () => {
  it.each([{ environmentResolved: false }, { timedOut: true }, { code: 1 }])(
    'rejects failed inventory probes but keeps background inventory empty: %j',
    async (failure) => {
      runWslProcessMock.mockImplementation(async ({ script }) =>
        script === ':' ? success : { ...success, ...failure }
      )
      await expect(
        detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
      ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
      await expect(detectWslCommandsOnPath({}, ['claude'])).resolves.toEqual(new Set())
    }
  )

  it.each([{ environmentResolved: false }, { timedOut: true }, { code: 1 }])(
    'rejects an unavailable guest before inventory can report a launcher: %j',
    async (failure) => {
      runWslProcessMock.mockImplementation(async ({ script }) =>
        script === ':' ? { ...success, ...failure } : success
      )
      await expect(
        detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
      ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    }
  )

  it('classifies process exceptions without breaking background discovery', async () => {
    runWslProcessMock.mockRejectedValue(new Error('WSL unavailable'))
    await expect(
      detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    await expect(detectWslCommandsOnPath({}, ['claude'])).resolves.toEqual(new Set())
  })

  it('allows a cold guest to boot separately from its bounded login-PATH inventory', async () => {
    let ready = false
    runWslProcessMock.mockImplementation(async ({ script, shell, loginPath, timeoutMs }) => {
      if (script === ':') {
        ready = shell === 'sh' && loginPath === 'none' && timeoutMs === 60_000
        return ready ? success : { ...success, timedOut: true }
      }
      return ready && shell === 'sh' && loginPath === 'preferred' && timeoutMs === 10_000
        ? success
        : { ...success, timedOut: true }
    })
    await expect(
      detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
    ).resolves.toEqual(new Set(['claude']))
  })
})
