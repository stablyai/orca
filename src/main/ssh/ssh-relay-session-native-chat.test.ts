import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD } from '../../shared/ssh-native-chat-relay'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: vi.fn(() => false),
  isSshPtyIdentityMismatchError: vi.fn(() => false),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))
vi.mock('../native-chat/ssh-transcript-dispatch', () => ({
  registerSshNativeChatTranscriptReader: vi.fn(),
  unregisterSshNativeChatTranscriptReader: vi.fn()
}))

const { registerSshNativeChatTranscriptReader } = await import(
  '../native-chat/ssh-transcript-dispatch'
)

const READ_PARAMS = { agent: 'claude', sessionId: 'abc', limit: 40 }

function methodNotFound(): Error & { code: number } {
  return Object.assign(new Error('Method not found: nativeChat.readTranscript'), { code: -32601 })
}

async function establishedSession(targetId = 'target-1'): Promise<SshRelaySession> {
  const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
  const connection = {
    sftp: vi.fn(),
    getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  } as unknown as SshConnection
  const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
  await session.establish(connection)
  return session
}

describe('SshRelaySession native chat transcript reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    mockDeploySuccess()
    muxRequestMock.mockResolvedValue({ ok: true })
  })

  it('registers a transcript reader for the target while the relay is up', async () => {
    await establishedSession()

    expect(registerSshNativeChatTranscriptReader).toHaveBeenCalledWith(
      'target-1',
      expect.any(Function)
    )
  })

  it('returns the relay result', async () => {
    const session = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) =>
      method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
        ? { messages: [], hasMore: false, beforeOffset: 0, fileSize: 12 }
        : { ok: true }
    )

    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toMatchObject({
      fileSize: 12
    })
  })

  it('falls back to null on a relay that predates the method, then stops asking', async () => {
    const session = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD) {
        throw methodNotFound()
      }
      return { ok: true }
    })

    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toBeNull()
    const callsAfterProbe = muxRequestMock.mock.calls.filter(
      ([method]) => method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
    ).length
    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toBeNull()

    // The probe is cached per connect: a poll loop must not re-ask every tick.
    expect(
      muxRequestMock.mock.calls.filter(
        ([method]) => method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
      )
    ).toHaveLength(callsAfterProbe)
  })

  it('re-probes after a reconnect, so a redeployed relay is picked up', async () => {
    // The same session instance must forget the fallback: a new instance would
    // start unprobed anyway and prove nothing.
    const session = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD) {
        throw methodNotFound()
      }
      return { ok: true }
    })
    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toBeNull()

    await session.reconnect({
      sftp: vi.fn(),
      getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    } as unknown as SshConnection)
    muxRequestMock.mockImplementation(async (method: string) =>
      method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
        ? { unchanged: true, fileSize: 12 }
        : { ok: true }
    )

    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toMatchObject({
      unchanged: true
    })
  })

  it('keeps capability state per target, so one host cannot disable another', async () => {
    const unsupported = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD) {
        throw methodNotFound()
      }
      return { ok: true }
    })
    await expect(unsupported.requestNativeChatTranscript(READ_PARAMS)).resolves.toBeNull()

    const other = await establishedSession('target-2')
    muxRequestMock.mockImplementation(async (method: string) =>
      method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
        ? { unchanged: true, fileSize: 12 }
        : { ok: true }
    )

    await expect(other.requestNativeChatTranscript(READ_PARAMS)).resolves.toMatchObject({
      unchanged: true
    })
  })

  it('latches the fallback once even when two callers race the first probe', async () => {
    // A poll loop and a manually opened chat view can overlap. Both learn the
    // method is missing; what matters is that the state latches so later callers
    // stop asking. There is no in-flight dedupe here, matching the AI Vault
    // methods beside it: the redundant probe costs one method-not-found reply.
    const session = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD) {
        throw methodNotFound()
      }
      return { ok: true }
    })

    const [first, second] = await Promise.all([
      session.requestNativeChatTranscript(READ_PARAMS),
      session.requestNativeChatTranscript(READ_PARAMS)
    ])
    expect(first).toBeNull()
    expect(second).toBeNull()

    const probesAfterRace = muxRequestMock.mock.calls.filter(
      ([method]) => method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
    ).length
    await expect(session.requestNativeChatTranscript(READ_PARAMS)).resolves.toBeNull()

    expect(
      muxRequestMock.mock.calls.filter(
        ([method]) => method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD
      )
    ).toHaveLength(probesAfterRace)
  })

  it('surfaces a non-capability failure instead of hiding it as a fallback', async () => {
    const session = await establishedSession()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD) {
        throw new Error('relay exploded')
      }
      return { ok: true }
    })

    await expect(session.requestNativeChatTranscript(READ_PARAMS)).rejects.toThrow('relay exploded')
  })
})
