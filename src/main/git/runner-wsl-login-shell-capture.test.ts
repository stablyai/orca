import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync, gitExecFileAsyncBuffer } from './runner'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

afterEach(() => _resetGitAdmissionForTests())
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'

const DISTRO = 'Ubuntu'
const WSL_CWD = String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`
const BANNER = 'To run a command as administrator (user "root"), use "sudo <command>".\n\n'

function createMockChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

/** Stand in for the guest shell: banner first, then the payload inside the command's fence. */
function respondWithFencedPayload(payload: Buffer | string): void {
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(String(args.at(-1)))?.[1] ?? ''
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
    const stdout = Buffer.concat([
      Buffer.from(BANNER, 'utf8'),
      Buffer.from(`__ORCA_WSL_CAPTURE_BEGIN_${nonce}__`, 'utf8'),
      body,
      Buffer.from(`__ORCA_WSL_CAPTURE_END_${nonce}__`, 'utf8')
    ])
    queueMicrotask(() => callback?.(null, stdout, Buffer.alloc(0)))
    return createMockChild()
  })
}

describe('WSL login-shell reads are fenced', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: process.platform })
    resetWslGitReadEnvironmentForTests()
  })

  it('returns blob bytes without the login-shell banner', async () => {
    respondWithFencedPayload('line one\nline two\n')

    const { stdout } = await gitExecFileAsyncBuffer(['show', ':file.txt'], {
      cwd: WSL_CWD,
      wslDistro: DISTRO
    })

    expect(stdout.toString('utf8')).toBe('line one\nline two\n')
  })

  it('keeps binary blob bytes intact through the fence', async () => {
    // Why bytes: decoding to a string to find the fence would mangle a PNG header.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0x00, 0x1b])
    respondWithFencedPayload(binary)

    const { stdout } = await gitExecFileAsyncBuffer(['show', ':image.png'], {
      cwd: WSL_CWD,
      wslDistro: DISTRO
    })

    expect(Buffer.compare(stdout, binary)).toBe(0)
  })

  /** Answer the core.sshCommand probe with `configured`, and any other command with ok. */
  function respondToSshPolicyProbe(configured: string): void {
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const script = String(args.at(-1))
      const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(script)?.[1] ?? ''
      const stdout = script.includes('core.sshCommand')
        ? `${BANNER}__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${configured}__ORCA_WSL_CAPTURE_END_${nonce}__`
        : 'ok'
      queueMicrotask(() => callback?.(null, stdout, ''))
      return createMockChild()
    })
  }

  function sshCommandFromLastGitCall(): string | undefined {
    const gitCall = execFileMock.mock.calls.findLast(
      (call) => !String(call[1]?.at(-1)).includes('core.sshCommand')
    )
    return (gitCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.GIT_SSH_COMMAND
  }

  it('keeps the BatchMode guard when core.sshCommand is unset behind a banner', async () => {
    // Banner-only reply: git printed nothing, so no sshCommand is configured.
    // Unfenced, the banner reads as a configured wrapper and the guard is dropped.
    respondToSshPolicyProbe('')

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: WSL_CWD,
      wslDistro: DISTRO,
      useConfiguredSshCommandForNetwork: true
    })

    expect(sshCommandFromLastGitCall()).toBe('ssh -o BatchMode=yes')
  })

  it('still honors a genuinely configured core.sshCommand', async () => {
    respondToSshPolicyProbe('ssh -i /home/alice/.ssh/id_ed25519\n')

    await gitExecFileAsync(['fetch', 'origin'], {
      cwd: WSL_CWD,
      wslDistro: DISTRO,
      useConfiguredSshCommandForNetwork: true
    })

    expect(sshCommandFromLastGitCall()).toContain('/home/alice/.ssh/id_ed25519')
    expect(sshCommandFromLastGitCall()).toContain('BatchMode=yes')
  })
})
