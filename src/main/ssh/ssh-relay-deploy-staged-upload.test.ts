import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn((os: string, arch: string) => {
    const normalizedOs = os.toLowerCase()
    const normalizedArch = arch.toLowerCase()
    const relayArch = normalizedArch === 'arm64' || normalizedArch === 'aarch64' ? 'arm64' : 'x64'
    if (normalizedOs === 'windows' || normalizedOs === 'win32') {
      return `win32-${relayArch}`
    }
    if (normalizedOs === 'darwin') {
      return `darwin-${relayArch}`
    }
    if (normalizedOs === 'linux') {
      return `linux-${relayArch}`
    }
    return null
  }),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import {
  RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS,
  RELAY_DEPLOY_TIMEOUT_MS
} from './ssh-relay-deploy-timing'
import type { SshConnection } from './ssh-connection'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

function stageCommandResponse(command: string): string | undefined {
  const marker = command.match(/\.sftp-namespace-[0-9a-f]{32}/u)?.[0]
  if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__') && marker) {
    return `__ORCA_UPLOAD_STAGE_SLOT__${marker}:slot-0`
  }
  if (command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__') && marker) {
    return `__ORCA_UPLOAD_STAGE_PROMOTION__${marker}:PROMOTED`
  }
  return command.includes('.upload-stages') ? '' : undefined
}

describe('deployAndLaunchRelay staged uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel).mockReset().mockResolvedValue({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
    vi.mocked(resolveRemoteNodePath).mockReset().mockResolvedValue('/usr/bin/node')
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(acquireInstallLock).mockReset().mockResolvedValue(undefined)
  })

  it('aborts an in-progress relay upload at the overall deploy timeout', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
      vi.mocked(execCommand).mockImplementation((_conn, command) => {
        if (command.includes('uname')) {
          return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        }
        if (command === 'echo $HOME') {
          return Promise.resolve('/home/user')
        }
        return Promise.resolve(stageCommandResponse(command) ?? '')
      })
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValueOnce(false).mockResolvedValueOnce(false)
      let uploadSignal: AbortSignal | undefined
      conn.uploadDirectory = vi.fn((_localDir, _remoteDir, options) => {
        uploadSignal = options?.signal
        return new Promise<void>((_resolve, reject) => {
          uploadSignal?.addEventListener('abort', () => reject(uploadSignal?.reason), {
            once: true
          })
        })
      })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(0)
      expect(conn.uploadDirectory).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(900_000)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Relay deployment timed out after 900s')
      expect(uploadSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('joins the bounded teardown window when an aborted transfer never settles', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
      vi.mocked(execCommand).mockImplementation((_conn, command) => {
        if (command.includes('uname')) {
          return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        }
        if (command === 'echo $HOME') {
          return Promise.resolve('/home/user')
        }
        return Promise.resolve(stageCommandResponse(command) ?? '')
      })
      let uploadSignal: AbortSignal | undefined
      conn.uploadDirectory = vi.fn((_localDir, _remoteDir, options) => {
        uploadSignal = options?.signal
        return new Promise<void>(() => {})
      })

      const deployment = deployAndLaunchRelay(conn).catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(conn.uploadDirectory).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      expect(uploadSignal?.aborted).toBe(true)
      expect(
        await Promise.race([deployment.then(() => 'settled'), Promise.resolve('pending')])
      ).toBe('pending')

      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS)
      await expect(deployment).resolves.toMatchObject({
        message: 'Relay deployment timed out after 900s',
        sshChannelCloseConfirmed: false,
        sshTransferTeardownConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a deferred SFTP upload before acquiring the install lock', async () => {
    const conn = makeMockConnection()
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      return Promise.resolve('')
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    let finishUpload: () => void = () => {}
    conn.uploadDirectory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpload = resolve
        })
    )

    const deploy = deployAndLaunchRelay(conn).catch(() => undefined)
    await vi.waitFor(() => expect(conn.uploadDirectory).toHaveBeenCalledTimes(1))
    expect(acquireInstallLock).not.toHaveBeenCalled()
    finishUpload()
    await vi.waitFor(() => expect(acquireInstallLock).toHaveBeenCalledTimes(1))
    await deploy
  })

  it('drops only its stage when a sibling finishes before the locked re-probe', async () => {
    const conn = makeMockConnection()
    const events: string[] = []
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockImplementationOnce(async () => {
        events.push('initial-probe')
        return false
      })
      .mockImplementationOnce(async () => {
        events.push('locked-re-probe')
        return true
      })
    vi.mocked(acquireInstallLock).mockImplementationOnce(async () => {
      events.push('lock')
    })
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      return Promise.resolve('')
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    conn.uploadDirectory = vi.fn().mockImplementation(async () => {
      events.push('upload')
    })

    await deployAndLaunchRelay(conn)

    expect(events).toEqual(['initial-probe', 'upload', 'lock', 'locked-re-probe'])
    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    expect(commands.some((command) => command.includes('cp -a'))).toBe(false)
    const uploadStageRemovals = commands.filter(
      (command) => /\.sftp-namespace-[0-9a-f]{32}/u.test(command) && command.includes('rm -rf')
    )
    expect(uploadStageRemovals).toHaveLength(1)
    expect(uploadStageRemovals[0]).toContain('/.orca-remote/.upload-stages/claim-0')
  })

  it('runs bounded fixed-path recovery before a fresh upload', async () => {
    const conn = makeMockConnection()
    const events: string[] = []
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      if (command.includes('deleting_old=')) {
        events.push('recover')
      }
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      return Promise.resolve('')
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    conn.uploadDirectory = vi.fn().mockImplementation(async () => {
      events.push('upload')
    })

    await deployAndLaunchRelay(conn)

    expect(events.indexOf('recover')).toBeLessThan(events.indexOf('upload'))
  })

  it('launches before one bounded installed-path recovery exec', async () => {
    const conn = makeMockConnection()
    const events: string[] = []
    let socketProbe = 0
    vi.mocked(waitForSentinel).mockImplementation(async () => {
      events.push('launch-ready')
      return {
        write: vi.fn(),
        onData: vi.fn(),
        onClose: vi.fn()
      }
    })
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      if (command.includes('deleting_old=')) {
        events.push('recover')
      }
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ % 2 === 0 ? 'DEAD' : 'READY')
      }
      return Promise.resolve('')
    })

    for (let deployment = 0; deployment < 12; deployment += 1) {
      await deployAndLaunchRelay(conn)
    }

    expect(events).toEqual(Array.from({ length: 12 }, () => ['launch-ready', 'recover']).flat())
    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    const recoveryCommands = commands.filter((command) => command.includes('deleting_old='))
    expect(recoveryCommands).toHaveLength(12)
    expect(recoveryCommands.every((command) => command.includes('.upload-stages'))).toBe(true)
    expect(recoveryCommands.every((command) => !command.includes('find "$pool"'))).toBe(true)
  })

  it('never enumerates arbitrary stage paths during installation', async () => {
    const conn = makeMockConnection()
    conn.uploadDirectory = vi.fn().mockResolvedValue(undefined)
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      return Promise.resolve('')
    })

    await deployAndLaunchRelay(conn)

    expect(conn.uploadDirectory).toHaveBeenCalledTimes(1)
    const stageCommands = vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes('.upload-stages'))
    expect(stageCommands.length).toBeGreaterThan(0)
    expect(stageCommands.every((command) => !command.includes('-mindepth'))).toBe(true)
  })

  it('keeps the staging tree after an unconfirmed system SSH upload termination', async () => {
    const conn = makeMockConnection()
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      return Promise.resolve(
        command.includes('uname') ? '__ORCA_REMOTE_PLATFORM__ Linux x86_64' : '/home/user'
      )
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    const termination = Object.assign(new Error('upload teardown unconfirmed'), {
      sshChannelCloseConfirmed: false
    })
    conn.uploadDirectory = vi.fn().mockRejectedValue(termination)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(termination)
    expect(acquireInstallLock).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(execCommand)
        .mock.calls.some(
          ([, command]) =>
            /\.sftp-namespace-[0-9a-f]{32}/u.test(command) && command.includes('rm -rf')
        )
    ).toBe(false)
  })

  it('retries immediately after an unconfirmed upload termination instead of waiting on a fresh install lock', async () => {
    const conn = makeMockConnection()
    const termination = Object.assign(new Error('upload teardown unconfirmed'), {
      sshChannelCloseConfirmed: false
    })
    let lockHeld = false
    vi.mocked(acquireInstallLock).mockImplementation((_conn, _dir, _host, options) => {
      if (!lockHeld) {
        lockHeld = true
        return Promise.resolve()
      }
      return new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true
        })
      })
    })
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      return Promise.resolve('')
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    conn.uploadDirectory = vi.fn().mockRejectedValueOnce(termination).mockResolvedValue(undefined)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(termination)
    await deployAndLaunchRelay(conn)

    expect(conn.uploadDirectory).toHaveBeenCalledTimes(2)
    expect(acquireInstallLock).toHaveBeenCalledTimes(1)
  })

  it('cleans a confirmed-abort staging tree so the next deployment retries immediately', async () => {
    const conn = makeMockConnection()
    const termination = Object.assign(new Error('upload aborted'), {
      sshChannelCloseConfirmed: true
    })
    vi.mocked(isRelayAlreadyInstalled)
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let socketProbe = 0
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const stageResponse = stageCommandResponse(command)
      if (stageResponse !== undefined) {
        return Promise.resolve(stageResponse)
      }
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('test -S')) {
        return Promise.resolve(socketProbe++ === 0 ? 'DEAD' : 'READY')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      return Promise.resolve('')
    })
    conn.writeFile = vi.fn().mockResolvedValue(undefined)
    conn.uploadDirectory = vi.fn().mockRejectedValueOnce(termination).mockResolvedValue(undefined)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(termination)
    expect(
      vi
        .mocked(execCommand)
        .mock.calls.some(
          ([, command]) =>
            /\.sftp-namespace-[0-9a-f]{32}/u.test(command) && command.includes('rm -rf')
        )
    ).toBe(true)

    await deployAndLaunchRelay(conn)
    expect(conn.uploadDirectory).toHaveBeenCalledTimes(2)
  })
})
