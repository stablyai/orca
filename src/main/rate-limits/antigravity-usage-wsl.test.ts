import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { listWslDistrosAsync } from '../wsl'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

vi.mock('../wsl-background-distro-gate', () => ({ isWslDistroRunning: vi.fn() }))
vi.mock('../wsl', () => ({ listWslDistrosAsync: vi.fn() }))

describe.skipIf(process.platform === 'win32')('Antigravity selected WSL usage', () => {
  let root: string
  let calls: ProcessSpec[]
  const resolveHostCommand = vi.fn(() => {
    throw new Error('Host CLI must not be resolved')
  })
  const resolveHostEnvironment = vi.fn(() => {
    throw new Error('Host login env must not be read')
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    resetAntigravityUsageSupportForTests()
    vi.mocked(isWslDistroRunning).mockResolvedValue(true)
    vi.mocked(listWslDistrosAsync).mockResolvedValue(['Ubuntu-24.04'])
    root = await mkdtemp(join(tmpdir(), 'orca-agy-wsl-'))
    calls = []
    await mkdir(join(root, 'bin'))
    const shell = join(root, 'bin', 'bash')
    const scripts = {
      getent: `#!/bin/sh\nprintf '%s\\n' ${quotePosixShell(`fixture:x:1000:1000::${root}:${shell}`)}\n`,
      bash: '#!/bin/sh\nprintf "Fixture login banner\\n"\nexec /bin/sh -c "$2"\n',
      agy: `#!/bin/sh
if [ "$AGY_CLI_DISABLE_AUTO_UPDATE" != true ]; then exit 99; fi
if [ "$1" = --version ]; then printf 'agy version 1.4.2\\n'; exit 0; fi
if [ "$*" != '-p /usage --output-format json --print-timeout 20s' ]; then exit 98; fi
if [ "$PWD" != "$HOME" ]; then exit 97; fi
if [ "$AGY_FIXTURE_BAD" = 1 ]; then
  printf '%s\\n' '{"conversation_id":"fixture","status":"SUCCESS","num_turns":1,"stats":{"models":{"fixture":{"tokens":{"total":1}}}}}'
else
  printf '%s\\n' '{"conversation_id":"","status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.4}]}]}}}'
fi
`
    }
    for (const [name, contents] of Object.entries(scripts)) {
      const path = join(root, 'bin', name)
      await writeFile(path, contents)
      await chmod(path, 0o700)
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const runTransport: typeof runProcess = async (spec) => {
    calls.push(spec)
    const script = spec.args?.at(-1)
    if (spec.program !== 'wsl.exe' || !script) {
      throw new Error('Expected a WSL transport command')
    }
    // Execute the generated guest script, using fixture tools instead of a real user login.
    return runProcess({
      ...spec,
      program: '/bin/sh',
      args: ['-c', script],
      cwd: root,
      env: {
        PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
        HOME: root,
        AGY_FIXTURE_BAD: spec.args?.[1] === 'Bad' ? '1' : '0'
      }
    })
  }

  const fetch = (distro: string | null, signal?: AbortSignal) =>
    fetchAntigravityRateLimits({
      target: { runtime: 'wsl', wslDistro: distro },
      platform: 'win32',
      resolveCommand: resolveHostCommand,
      resolveEnvironment: resolveHostEnvironment,
      runCommand: runTransport,
      signal
    })

  it('runs the free version and usage commands inside the selected distro and strips banners', async () => {
    const result = await fetch('Ubuntu-24.04')

    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(60)
    expect(result.usageMetadata?.authProvenance).toBe('wsl:ubuntu-24.04')
    expect(calls).toHaveLength(2)
    for (const spec of calls) {
      expect(spec.args?.slice(0, 3)).toEqual(['-d', 'Ubuntu-24.04', '--exec'])
      expect(spec.cwd).toBeTruthy()
    }
    expect(resolveHostCommand).not.toHaveBeenCalled()
    expect(resolveHostEnvironment).not.toHaveBeenCalled()
  })

  it('resolves the default distro before probing and never starts a stopped distro', async () => {
    vi.mocked(isWslDistroRunning).mockResolvedValue(false)
    const result = await fetch(null)
    expect(result.status).toBe('unavailable')
    expect(result.weekly).toBeNull()
    expect(calls).toEqual([])
    expect(isWslDistroRunning).toHaveBeenCalledWith('Ubuntu-24.04')
    expect(resolveHostCommand).not.toHaveBeenCalled()
  })

  it('does not pass a WSLENV-named host secret into the spawned probe process', async () => {
    vi.stubEnv('WSLENV', 'ORCA_AGY_TEST_HOST_SECRET')
    vi.stubEnv('ORCA_AGY_TEST_HOST_SECRET', 'test-only-secret')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    let checked = 0
    const result = await fetchAntigravityRateLimits({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu-24.04' },
      platform: 'win32',
      resolveCommand: resolveHostCommand,
      resolveEnvironment: resolveHostEnvironment,
      runCommand: async (spec) => {
        const child = await runProcess({
          program: process.execPath,
          args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'],
          env: spec.env,
          timeoutMs: 5000
        })
        expect(child.code).toBe(0)
        const names: unknown = JSON.parse(child.stdout)
        expect(names).not.toContain('WSLENV')
        expect(names).not.toContain('ORCA_AGY_TEST_HOST_SECRET')
        expect(names).toContain('PATH')
        expect(names).toContain('SystemRoot')
        checked += 1
        return runTransport(spec)
      }
    })
    expect(result.status).toBe('ok')
    expect(checked).toBe(2)
  })

  it('keeps a CLI that spends a model turn latched only in its own distro', async () => {
    const bad = await fetch('Bad')
    expect(bad.status).toBe('unavailable')
    expect(bad.error).toContain('answers `/usage` as a prompt')
    const callsAfterBad = calls.length
    await fetch('Bad')
    expect(calls).toHaveLength(callsAfterBad)

    const good = await fetch('Ubuntu-24.04')
    expect(good.status).toBe('ok')
    expect(good.weekly?.usedPercent).toBe(60)
  })

  it('does not launch any probe after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await fetch('Ubuntu-24.04', controller.signal)
    expect(result.status).not.toBe('ok')
    expect(isWslDistroRunning).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
