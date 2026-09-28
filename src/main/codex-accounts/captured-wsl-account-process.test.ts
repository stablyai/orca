import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCapturedCodexWslProcess } from './captured-wsl-account-process'
import {
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain,
  _internals
} from './legacy-wsl-runtime-auth-drain'
import { startWslCodexSessionBridgeInBackground } from '../codex/wsl-codex-session-bridge'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
const owner = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
const result = (code = 0, stdout = '') => ({
  code,
  stdout,
  stderr: '',
  timedOut: false,
  environmentResolved: true
})
const options = () => ({
  distro: 'Ubuntu',
  guestHomeLinuxPath: '/home/alice',
  legacyPanePresent: true,
  execution: { ...owner },
  resolveDestination: vi.fn(() => null)
})

beforeEach(() => {
  runWslProcessMock.mockReset()
  _internals.resetDrainQueue()
})

describe('captured WSL Codex owner', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses UID drift before a real shell writes credentials',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-captured-wsl-'))
      const destination = join(directory, 'auth.json')
      runWslProcessMock.mockImplementation((spec) =>
        runProcess({ program: '/bin/sh', args: ['-c', spec.script] })
      )
      try {
        const response = await runCapturedCodexWslProcess(
          { distro: 'Ubuntu', loginPath: 'none', script: `touch ${shellEscape(destination)}` },
          { ...owner, userId: String((process.getuid?.() ?? 0) + 1) }
        )
        expect(response.code).toBe(79)
        expect(existsSync(destination)).toBe(false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('pins the user and checks UID/home before the credential script', async () => {
    runWslProcessMock.mockResolvedValue(result())
    await runCapturedCodexWslProcess(
      { distro: 'Ubuntu', script: 'touch auth.json', loginPath: 'none' },
      owner
    )
    const spec = runWslProcessMock.mock.calls[0]?.[0]
    expect(spec.user).toBe('alice')
    expect(spec.script).toContain('id -u')
    expect(spec.script).toContain('1000')
    expect(spec.script).toContain('/home/alice')
    expect(spec.script.indexOf('exit 79')).toBeLessThan(spec.script.indexOf('touch auth.json'))
  })

  it('rejects a different distro and drain home before guest work', async () => {
    expect(() =>
      runCapturedCodexWslProcess(
        { distro: 'Debian', script: 'touch auth.json', loginPath: 'none' },
        owner
      )
    ).toThrow('captured execution owner')
    await expect(
      drainLegacyWslRuntimeAuth({ ...options(), guestHomeLinuxPath: '/home/bob' })
    ).rejects.toThrow('captured owner')
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('keeps the captured user through an asynchronous drain destination lookup', async () => {
    const execution = { ...owner }
    const fresh = '{"tokens":{"expires_at":2000}}'
    const stale = '{"tokens":{"expires_at":1000}}'
    runWslProcessMock
      .mockResolvedValueOnce(
        result(0, [Buffer.from(fresh).toString('base64'), 'missing', ''].join('\n'))
      )
      .mockResolvedValue(result())
    await drainLegacyWslRuntimeAuth({
      ...options(),
      execution,
      resolveDestination: async () => {
        execution.userName = 'bob'
        execution.userId = '1001'
        execution.home = '/home/bob'
        await Promise.resolve()
        return { authContents: stale, linuxHomePath: '/home/alice/.codex' }
      }
    })
    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    for (const [spec] of runWslProcessMock.mock.calls) {
      expect(spec.user).toBe('alice')
      expect(spec.script).toContain('/home/alice')
      expect(spec.script).not.toContain('/home/bob')
    }
  })

  it('does not coalesce drains for two users in the same distro', async () => {
    runWslProcessMock.mockResolvedValue(result(0, ''))
    await Promise.all([
      startLegacyWslRuntimeAuthDrain(options()),
      startLegacyWslRuntimeAuthDrain({
        ...options(),
        guestHomeLinuxPath: '/home/bob',
        execution: { ...owner, userName: 'bob', userId: '1001', home: '/home/bob' }
      })
    ])
    expect(runWslProcessMock.mock.calls.map(([spec]) => spec.user).sort()).toEqual(['alice', 'bob'])
  })

  it('does not coalesce session bridges across captured users', async () => {
    runWslProcessMock.mockResolvedValue(result())
    const target = {
      distro: 'Ubuntu',
      systemCodexHomePath: '/shared/system',
      managedCodexHomePath: '/shared/managed'
    }
    await Promise.all([
      startWslCodexSessionBridgeInBackground({ ...target, execution: owner }),
      startWslCodexSessionBridgeInBackground({
        ...target,
        execution: { ...owner, userName: 'bob', userId: '1001', home: '/home/bob' }
      })
    ])
    expect(runWslProcessMock.mock.calls.map(([spec]) => spec.user).sort()).toEqual(['alice', 'bob'])
  })
})
