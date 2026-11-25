import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCodexInstallation } from './codex-automation-update'

const { latestRelease, launchEnvironment, profileDirectory } = vi.hoisted(() => ({
  latestRelease: vi.fn(),
  launchEnvironment: vi.fn(),
  profileDirectory: vi.fn()
}))
vi.mock('./agent-cli-latest-release', () => ({ latestAgentCliRelease: latestRelease }))
vi.mock('../runtime/agent-session/launch/structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: launchEnvironment
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: profileDirectory
}))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function disposableCodex(version: string, update: string, pathPrefix = '') {
  const home = await mkdtemp(join(tmpdir(), 'orca-codex-update-'))
  directories.push(home)
  const bin = join(home, '.local', 'bin')
  const root = join(home, '.codex', 'packages', 'standalone')
  const release = join(root, 'releases', version)
  const currentVersion = '0.170.0'
  const updatedRelease = join(root, 'releases', currentVersion, 'bin')
  const current = join(root, 'current', 'bin')
  await Promise.all(
    [bin, release, updatedRelease, current].map((path) => mkdir(path, { recursive: true }))
  )
  const installed = join(release, 'codex')
  const updated = join(updatedRelease, 'codex')
  await Promise.all([
    writeFile(
      installed,
      `#!/bin/sh
set -eu
case "$1" in
  --version) printf 'codex-cli %s\\n' '${version}' ;;
  update)
    printf 'update\\n' >> "$HOME/updates"
    ${update}
    ;;
esac
`,
      { mode: 0o755 }
    ),
    writeFile(updated, `#!/bin/sh\nprintf 'codex-cli %s\\n' '${currentVersion}'\n`, { mode: 0o755 })
  ])
  const program = join(bin, 'codex')
  await symlink(installed, join(current, 'codex'))
  await symlink(join(current, 'codex'), program)
  profileDirectory.mockReturnValue(join(home, 'orca-profile'))
  launchEnvironment.mockResolvedValue({
    HOME: home,
    PATH: `${pathPrefix}${bin}:/usr/bin:/bin`
  })
  latestRelease.mockResolvedValue(currentVersion)
  return {
    program,
    updates: () => readFile(join(home, 'updates'), 'utf8').catch(() => '')
  }
}

const settings = {
  agentDefaultEnv: {},
  nativeChatInheritShellEnvironment: false,
  nativeChatShellEnvironmentVariables: [],
  httpProxyUrl: '',
  httpProxyBypassRules: ''
}

const swapRelease = `
  root="$CODEX_HOME/packages/standalone"
  ln -s "$root/releases/0.170.0/bin/codex" "$root/current/bin/next"
  mv -f "$root/current/bin/next" "$root/current/bin/codex"
`

describe.skipIf(process.platform === 'win32')('preparing Codex for automation', () => {
  it('shares a single update and releases both callers with the verified launcher', async () => {
    const cli = await disposableCodex('0.168.0', swapRelease)
    const prepare = () => prepareCodexInstallation(settings, new AbortController().signal)
    await expect(Promise.all([prepare(), prepare()])).resolves.toEqual([cli.program, cli.program])
    expect(await cli.updates()).toBe('update\n')
    await expect(prepare()).resolves.toBe(cli.program)
    expect(await cli.updates()).toBe('update\n')
  })

  it('refuses a clean updater exit while the actual executable is still behind', async () => {
    const cli = await disposableCodex('0.168.0', 'exit 0')
    await expect(prepareCodexInstallation(settings, new AbortController().signal)).rejects.toThrow(
      'Orca could not verify the required Codex version after updating.'
    )
    expect(await cli.updates()).toBe('update\n')
  })

  it('reports the exit code without publishing updater output', async () => {
    await disposableCodex('0.168.0', "echo 'private updater output' >&2; exit 23")
    await expect(prepareCodexInstallation(settings, new AbortController().signal)).rejects.toThrow(
      /^The Codex updater failed \(exit code 23\)\.$/
    )
  })

  it('refuses an install that needs a manual update', async () => {
    const cli = await disposableCodex('0.125.0', 'exit 0')
    await expect(prepareCodexInstallation(settings, new AbortController().signal)).rejects.toThrow(
      'This Codex installation requires a manual update before the run can start.'
    )
    expect(await cli.updates()).toBe('')
  })

  it('settles a cancelled waiter without cancelling the update for another run', async () => {
    const cli = await disposableCodex('0.168.0', swapRelease)
    const cancelled = new AbortController()
    const remaining = new AbortController()
    const checking = Promise.withResolvers<void>()
    const release = Promise.withResolvers<string>()
    const joined = Promise.withResolvers<void>()
    const any = AbortSignal.any.bind(AbortSignal)
    let remainingWait: AbortSignal | undefined
    vi.spyOn(AbortSignal, 'any').mockImplementation((signals) => {
      const combined = any(signals)
      if (signals[0] === remaining.signal) {
        remainingWait = combined
      } else if (remainingWait && signals[0] === remainingWait) {
        joined.resolve()
      }
      return combined
    })
    latestRelease.mockImplementationOnce(() => {
      checking.resolve()
      return release.promise
    })
    const failure = new Error('Run cancelled')
    const expired = prepareCodexInstallation(settings, cancelled.signal)
    await checking.promise
    const active = prepareCodexInstallation(settings, remaining.signal)
    try {
      await joined.promise
      cancelled.abort(failure)
      await expect(expired).rejects.toBe(failure)
    } finally {
      release.resolve('0.170.0')
    }
    await expect(active).resolves.toBe(cli.program)
    expect(await cli.updates()).toBe('update\n')
  })

  it('refuses to update a new workspace launch with a workspace-relative PATH', async () => {
    const cli = await disposableCodex('0.168.0', swapRelease, 'workspace-bin:')
    await expect(prepareCodexInstallation(settings, new AbortController().signal)).rejects.toThrow(
      'Orca cannot verify Codex for a new workspace with a relative PATH entry.'
    )
    expect(await cli.updates()).toBe('')
  })

  it('surfaces expiry while the latest release is still being read', async () => {
    const cli = await disposableCodex('0.168.0', 'exit 0')
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    latestRelease.mockImplementationOnce(async () => {
      deadline.abort(new DOMException('Test deadline reached', 'TimeoutError'))
      return '0.170.0'
    })
    await expect(prepareCodexInstallation(settings, new AbortController().signal)).rejects.toThrow(
      'The Codex update timed out.'
    )
    expect(await cli.updates()).toBe('')
  })
})
