import { describe, expect, it, vi } from 'vitest'
import {
  makeMockConnection,
  queueLaunchNamespaceAndDeadSocketProbe
} from './ssh-relay-deploy-test-fixture'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { existsSync, readFileSync } from 'node:fs'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { detectRemoteOrcadTarget } from './orcad-remote-target-detection'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import * as DeployTiming from './ssh-relay-deploy-timing'
import type * as SshRemoteNodeResolution from './ssh-remote-node-resolution'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../shared/ssh-types'

describe('deployAndLaunchRelay', () => {
  it('calls exec to detect remote platform', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // echo $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(mockExecCommand).toHaveBeenCalledWith(
      conn,
      "printf '\\n%s ' '__ORCA_REMOTE_PLATFORM__'; uname -sm",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports progress via callback', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    const progress: string[] = []
    await deployAndLaunchRelay(conn, (status) => progress.push(status))

    expect(progress).toContain('Detecting remote platform...')
    expect(progress).toContain('Starting relay...')
  })

  it('does not launch fresh after an unconfirmed endpoint-incumbent probe', async () => {
    const conn = makeMockConnection()
    const unconfirmedCleanup = Object.assign(new Error('endpoint probe still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('stale relay reconnect failed'))
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // launch namespace marker
      .mockResolvedValueOnce('ALIVE')
      .mockRejectedValueOnce(unconfirmedCleanup)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(unconfirmedCleanup)

    const commands = vi.mocked(conn.exec).mock.calls.map(([command]) => command)
    expect(commands).toHaveLength(1)
    expect(commands.some((command) => command.includes('--detached'))).toBe(false)
  })

  it('resolves the remote node path once per deploy', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('uses target-native Bun without probing remote Node or npm', async () => {
    const conn = makeMockConnection()
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith('.bun-required') ? 'bun\n' : '0.1.0+abcdef012345'
    )
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathname = String(path)
      if (pathname.endsWith('bun-runtime-glibc')) {
        return true
      }
      return !/bun-runtime(?:-|$)/u.test(pathname)
    })
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('READY') // strict Bun runtime verification
    mockExecCommand.mockResolvedValueOnce('DEAD')
    mockExecCommand.mockResolvedValueOnce('')
    mockExecCommand.mockResolvedValueOnce('READY')

    const result = await deployAndLaunchRelay(conn)

    expect(detectRemoteOrcadTarget).toHaveBeenCalledTimes(1)
    expect(result.runtimeKind).toBe('bun')
    expect(result.runtimePath).toContain('bun-runtime-glibc')
    expect(result.nodePath).toBeUndefined()
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    const commands = [
      ...mockExecCommand.mock.calls.map(([command]) => command),
      ...vi.mocked(conn.exec).mock.calls.map(([command]) => command as string)
    ].filter((command): command is string => typeof command === 'string')
    expect(commands.some((command) => command.includes('bun-runtime-glibc'))).toBe(true)
    expect(commands.some((command) => /(?:^|[^A-Za-z])node(?:[^A-Za-z]|$)/u.test(command))).toBe(
      false
    )
    expect(commands.some((command) => /\bnpm\b/u.test(command))).toBe(false)
  })

  it('fails closed when a libc-specific bundle has no matching remote target', async () => {
    const conn = makeMockConnection()
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith('.bun-required') ? 'bun\n' : '0.1.0+abcdef012345'
    )
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathname = String(path)
      if (pathname.endsWith('bun-runtime-glibc')) {
        return true
      }
      return !/bun-runtime(?:-|$)/u.test(pathname)
    })
    vi.mocked(detectRemoteOrcadTarget).mockResolvedValueOnce('linux-arm64-musl')
    vi.mocked(execCommand).mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(
      'Relay package has no Bun runtime for remote target linux-arm64-musl'
    )
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
  })

  it('resolves node concurrently with remote home, not after the install-state chain', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe

    let markNodeResolutionStarted: () => void = () => {}
    const nodeResolutionStarted = new Promise<void>((resolve) => {
      markNodeResolutionStarted = resolve
    })
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => {
      markNodeResolutionStarted()
      return Promise.resolve('/usr/bin/node')
    })

    // Hold the first install-state step open. The optimization starts the node
    // branch before the remote-home -> install-check chain finishes.
    let releaseRemoteHome: (home: string) => void = () => {}
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRemoteHome = resolve
      })
    )

    const deployPromise = deployAndLaunchRelay(conn)
    let assertionError: unknown
    let deployError: unknown
    try {
      await nodeResolutionStarted

      expect(isRelayAlreadyInstalled).not.toHaveBeenCalled()
      expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
    } catch (err) {
      assertionError = err
    } finally {
      // Drain the rest of the happy path so a failed assertion does not leave
      // the deploy promise pending until the overall deploy timeout.
      mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
      queueLaunchNamespaceAndDeadSocketProbe()
      mockExecCommand.mockResolvedValueOnce('READY') // socket poll
      releaseRemoteHome('/home/user')
      deployError = await deployPromise.then(
        () => undefined,
        (err: unknown) => err
      )
    }
    if (assertionError) {
      throw assertionError
    }
    if (deployError) {
      throw deployError
    }
  })

  it('keeps bootstrap sequential when the connection cannot run concurrent exec commands', async () => {
    const conn = makeMockConnection()
    vi.mocked(conn.canRunConcurrentExecCommands).mockReturnValue(false)
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    let releaseRemoteHome: (home: string) => void = () => {}
    let remoteHomeProbeStarted: () => void = () => {}
    const remoteHomeProbeStartedPromise = new Promise<void>((resolve) => {
      remoteHomeProbeStarted = resolve
    })
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        remoteHomeProbeStarted()
        releaseRemoteHome = resolve
      })
    )

    const deployPromise = deployAndLaunchRelay(conn)
    await remoteHomeProbeStartedPromise
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()

    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll
    releaseRemoteHome('/home/user')
    await deployPromise
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('falls back to sequential bootstrap when concurrent SSH sessions are refused', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    const { resolveRemoteNodePath: resolveRemoteNodePathActual } = await vi.importActual<
      typeof SshRemoteNodeResolution
    >('./ssh-remote-node-resolution')
    let fallbackInstallStateCompleted = false
    vi.mocked(resolveRemoteNodePath)
      .mockImplementationOnce(resolveRemoteNodePathActual)
      .mockImplementationOnce(() => {
        if (!fallbackInstallStateCompleted) {
          throw new Error('Sequential fallback resolved node before install state finished')
        }
        return Promise.resolve('/usr/bin/node')
      })
    vi.mocked(isRelayAlreadyInstalled)
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        expect(options?.rethrowSessionLimitErrors).toBe(true)
        return true
      })
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        expect(options?.rethrowSessionLimitErrors).toBeUndefined()
        fallbackInstallStateCompleted = true
        return true
      })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME
    mockExecCommand.mockRejectedValueOnce(sessionLimitError) // concurrent node path probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(3)
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[2]?.[3]).toMatchObject({
      rethrowSessionLimitErrors: true
    })
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('falls back to sequential bootstrap when the install-state probe hits a session limit', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    vi.mocked(isRelayAlreadyInstalled)
      .mockImplementationOnce(async (_conn, _dir, _host, options) => {
        if (!options?.rethrowSessionLimitErrors) {
          return true
        }
        throw sessionLimitError
      })
      .mockResolvedValueOnce(true)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME
    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll

    await deployAndLaunchRelay(conn)

    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(3)
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[0]?.[3]).toMatchObject({
      rethrowSessionLimitErrors: true
    })
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[1]?.[3]).toMatchObject({
      rethrowSessionLimitErrors: undefined,
      signal: expect.any(AbortSignal)
    })
    expect(vi.mocked(isRelayAlreadyInstalled).mock.calls[2]?.[3]).toMatchObject({
      rethrowSessionLimitErrors: true
    })
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('does not retry bootstrap for non-session failures', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const nodeError = new Error('Node.js not found on remote host')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(nodeError)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(nodeError)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(1)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('aborts a pending sibling probe and preserves a non-session install-state failure', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    let nodeProbeAborted = false
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce((_conn, _host, options) => {
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          nodeProbeAborted = true
          const abortError = new Error('aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        })
      })
    })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('relative-home') // invalid install-state $HOME

    const timedDeploy = Promise.race([
      deployAndLaunchRelay(conn),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('deploy did not fail promptly')), 100)
      })
    ])

    await expect(timedDeploy).rejects.toThrow(/Remote home is not a valid path/)
    expect(nodeProbeAborted).toBe(true)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('does not retry when a session-limit failure races with a real install-state failure', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    const installError = new Error('permission denied while checking relay install')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(sessionLimitError)
    vi.mocked(isRelayAlreadyInstalled).mockRejectedValueOnce(installError)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    mockExecCommand.mockResolvedValueOnce('/home/user') // concurrent install-state $HOME

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(installError)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(1)
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)
  })

  it('does not retry until the surviving first-attempt probe settles', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const sessionLimitError = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4
    })
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64') // tagged POSIX platform probe
    let releaseRemoteHome: (home: string) => void = () => {}
    let remoteHomeSettled = false
    mockExecCommand.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseRemoteHome = (home: string) => {
          remoteHomeSettled = true
          resolve(home)
        }
      })
    )
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => Promise.reject(sessionLimitError))
    vi.mocked(resolveRemoteNodePath).mockImplementationOnce(() => {
      if (!remoteHomeSettled) {
        throw new Error('Sequential fallback started before first install-state probe settled')
      }
      return Promise.resolve('/usr/bin/node')
    })

    const deployPromise = deployAndLaunchRelay(conn)
    await vi.waitFor(() => expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(1)

    mockExecCommand.mockResolvedValueOnce('/home/user') // sequential fallback $HOME
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK') // native deps probe
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY') // socket poll
    releaseRemoteHome('/home/user')
    await deployPromise
    expect(resolveRemoteNodePath).toHaveBeenCalledTimes(2)
  })

  it('defaults fresh relays to keep-alive-until-reset without rollout artifacts', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain(`--grace-time ${DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
    expect(launchCommand).not.toContain('--enable-ownership-transfer-mutation')
    expect(launchCommand).not.toContain('--enable-delegated-ownership-capture')
    expect(launchCommand).not.toContain('--enable-source-delivery-retirement')
    expect(launchCommand).not.toContain('--pty-source-credit-v1')
    expect(launchCommand).not.toContain('.pty-source-credit-policy')
  })

  it('adds the ownership-transfer mutation flag only for an explicit canary launch', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn, undefined, 300, 'target-a', {
      enableOwnershipTransferMutation: true
    })

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain('--enable-ownership-transfer-mutation')
    expect(launchCommand).toContain('--enable-delegated-ownership-capture')
    expect(launchCommand).toContain('--enable-source-delivery-retirement')
  })

  it('allows an unlimited SSH disconnect grace window', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn, undefined, 0, 'target-a')

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain('--grace-time 0')
    expect(launchCommand).not.toContain('--pty-source-credit-v1')
    expect(launchCommand).not.toContain('.pty-source-credit-policy')
  })

  it('clamps configured SSH disconnect grace to the seven-day maximum', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn, undefined, MAX_SSH_RELAY_GRACE_PERIOD_SECONDS + 1, 'target-a')

    const launchCommand = vi
      .mocked(conn.exec)
      .mock.calls.map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes('--detached'))

    expect(launchCommand).toContain(`--grace-time ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}`)
  })

  it('uses a content-hashed versioned remote install directory', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    mockExecCommand.mockResolvedValueOnce('/home/user')
    mockExecCommand.mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    queueLaunchNamespaceAndDeadSocketProbe()
    mockExecCommand.mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    // The launch + connect commands include the versioned dir path.
    const execArgs = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    const allCmds = [...execArgs, ...mockExecCommand.mock.calls.map(([, cmd]) => cmd)]
    const sawVersionedDir = allCmds.some((cmd) =>
      cmd.includes('/.orca-remote/relay-0.1.0+abcdef012345')
    )
    expect(sawVersionedDir).toBe(true)
    const sawLegacyDir = allCmds.some((cmd) => cmd.includes('relay-v0.1.0'))
    expect(sawLegacyDir).toBe(false)
  })

  it('bounds the overall deploy so install + rebuild both fit under the timeout', async () => {
    // Why: the outer bound must exceed the worst-case sequential native-deps
    // work — a first install (240s) AND a follow-up rebuild (240s) — so a
    // legitimate install-then-rebuild is not falsely timed out mid-repair.
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)

    // Make the first exec never resolve
    mockExecCommand.mockReturnValueOnce(new Promise(() => {}))

    vi.useFakeTimers()

    // Catch the rejection immediately to avoid unhandled rejection warning
    const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)

    // Not timed out yet at the old 300s bound (install + rebuild need more).
    await vi.advanceTimersByTimeAsync(301_000)
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending')

    await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TIMEOUT_MS - 301_000)
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending')

    await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('Relay deployment timed out after 900s')

    vi.useRealTimers()
  })

  it('aborts a contended install-lock wait at the overall deploy timeout', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
      conn.uploadDirectory = vi.fn().mockResolvedValue(undefined)
      conn.writeFile = vi.fn().mockResolvedValue(undefined)
      vi.mocked(execCommand).mockImplementation((_conn, command) => {
        if (command.includes('uname')) {
          return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        }
        if (command === 'echo $HOME') {
          return Promise.resolve('/home/user')
        }
        const marker = command.match(/\.sftp-namespace-[0-9a-f]{32}/u)?.[0]
        if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__') && marker) {
          return Promise.resolve(`__ORCA_UPLOAD_STAGE_SLOT__${marker}:slot-0`)
        }
        return Promise.resolve('')
      })
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValueOnce(false)
      let lockSignal: AbortSignal | undefined
      vi.mocked(acquireInstallLock).mockImplementationOnce((_conn, _dir, _host, options) => {
        lockSignal = options?.signal
        return new Promise<void>((_resolve, reject) => {
          lockSignal?.addEventListener('abort', () => reject(lockSignal?.reason), { once: true })
        })
      })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(0)
      expect(acquireInstallLock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(DeployTiming.RELAY_DEPLOY_TIMEOUT_MS)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Relay deployment timed out after 900s')
      expect(lockSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a launch started near the deploy deadline and closes its channel once', async () => {
    vi.useFakeTimers()
    try {
      const launchChannel = {
        on: vi.fn(),
        stderr: { on: vi.fn() },
        stdin: {},
        stdout: { on: vi.fn() },
        close: vi.fn()
      }
      const conn = makeMockConnection()
      vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
      vi.mocked(conn.exec).mockResolvedValue(launchChannel as never)
      const mockExecCommand = vi.mocked(execCommand)
      mockExecCommand
        .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
        .mockResolvedValueOnce('/home/user')
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('ORCA-NATIVE-DEPS-OK'), 899_900)
            )
        )
        .mockResolvedValueOnce('') // launch namespace marker
        .mockResolvedValueOnce('DEAD')
        .mockImplementationOnce((_conn, _command, options) => {
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('SSH operation was cancelled')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true }
            )
          })
        })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(899_900)
      expect(conn.exec).toHaveBeenCalledTimes(1)
      expect(launchChannel.close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Relay deployment timed out after 900s')
      expect(launchChannel.close).toHaveBeenCalledTimes(1)
      expect(mockExecCommand).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockExecCommand).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses distinct target-specific relay socket paths', async () => {
    const connA = makeMockConnection()
    const connB = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    mockExecCommand.mockImplementation((_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('ORCA-NATIVE')) {
        return Promise.resolve('ORCA-NATIVE-DEPS-OK')
      }
      if (command.includes('process.stdout.write("READY")')) {
        return Promise.resolve('READY')
      }
      if (command.includes('test -S')) {
        return Promise.resolve('DEAD')
      }
      return Promise.resolve('')
    })

    await deployAndLaunchRelay(connA, undefined, 300, 'target-a')
    await deployAndLaunchRelay(connB, undefined, 300, 'target-b')

    const probeCommands = mockExecCommand.mock.calls
      .map(([, command]) => command)
      .filter(
        (command) =>
          command.includes('test -S') && command.includes('relay-') && command.includes('ALIVE')
      )
    expect(probeCommands).toHaveLength(2)
    expect(probeCommands[0]).toContain('relay-')
    expect(probeCommands[0]).not.toContain('relay.sock')
    expect(probeCommands[1]).toContain('relay-')
    expect(probeCommands[1]).not.toContain('relay.sock')
    expect(probeCommands[0]).not.toEqual(probeCommands[1])

    const launchA = vi.mocked(connA.exec).mock.calls.at(-1)?.[0] ?? ''
    const launchB = vi.mocked(connB.exec).mock.calls.at(-1)?.[0] ?? ''
    expect(launchA).toContain('--sock-path')
    expect(launchB).toContain('--sock-path')
    expect(launchA).not.toEqual(launchB)
  })
})
