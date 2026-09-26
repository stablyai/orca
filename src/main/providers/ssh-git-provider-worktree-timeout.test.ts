import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  SshChannelMultiplexer,
  SSH_MUX_REQUEST_TIMEOUT_CODE,
  type MultiplexerTransport
} from '../ssh/ssh-channel-multiplexer'
import {
  encodeFrame,
  encodeKeepAliveFrame,
  HEADER_LENGTH,
  MessageType,
  parseJsonRpcMessage
} from '../ssh/relay-protocol'
import { SshGitProvider } from './ssh-git-provider'

type WorktreeAddOperation = {
  running: boolean
  completed: boolean
  cancelReceived: boolean
}

type RelayFixture = {
  mux: SshChannelMultiplexer
  provider: SshGitProvider
  legacyProvider: LegacySshGitProvider
  operation: WorktreeAddOperation
}

class LegacySshGitProvider extends SshGitProvider {
  override async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.addWorktree', {
        repoPath,
        branchName,
        targetDir,
        ...options
      })
    })
  }
}

function createRelayFixture(operationDurationMs: number): RelayFixture {
  let onData: (data: Buffer) => void = () => {}
  let onClose: () => void = () => {}
  let relaySequence = 0
  const operation: WorktreeAddOperation = {
    running: false,
    completed: false,
    cancelReceived: false
  }

  const transport: MultiplexerTransport = {
    write(data) {
      const frameType = data[0]
      const sequence = data.readUInt32BE(1)
      if (frameType === MessageType.KeepAlive) {
        onData(encodeKeepAliveFrame(++relaySequence, sequence))
        return
      }

      const payloadLength = data.readUInt32BE(9)
      const message = parseJsonRpcMessage(
        data.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength)
      )
      if (!('method' in message)) {
        return
      }
      if (message.method === 'rpc.cancel') {
        operation.cancelReceived = true
        return
      }
      if (!('id' in message) || message.method !== 'git.addWorktree') {
        return
      }

      const request = message
      operation.running = true
      setTimeout(() => {
        operation.running = false
        operation.completed = true
        const response = Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }),
          'utf8'
        )
        onData(encodeFrame(MessageType.Regular, ++relaySequence, sequence, response))
      }, operationDurationMs)
    },
    onData(callback) {
      onData = callback
    },
    onClose(callback) {
      onClose = callback
    },
    close() {
      onClose()
    }
  }

  const mux = new SshChannelMultiplexer(transport)
  return {
    mux,
    provider: new SshGitProvider('conn-1', mux),
    legacyProvider: new LegacySshGitProvider('conn-1', mux),
    operation
  }
}

describe('SSH worktree add timeout through the relay boundary', () => {
  beforeEach(() => vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', undefined))

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('shows the old 30s failure while the host operation remains running', async () => {
    vi.useFakeTimers({ now: 0 })
    const fixture = createRelayFixture(60_000)
    const request = fixture.legacyProvider.addWorktree('/repo', 'feature', '/repo-feature')
    const rejection = request.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(30_001)
    await expect(rejection).resolves.toMatchObject({ code: SSH_MUX_REQUEST_TIMEOUT_CODE })
    expect(fixture.operation).toMatchObject({
      running: true,
      completed: false,
      cancelReceived: true
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(fixture.operation).toMatchObject({ running: false, completed: true })
    fixture.mux.dispose()
  })

  it('keeps the real provider request alive past 30s and resolves when the host finishes', async () => {
    vi.useFakeTimers({ now: 0 })
    const fixture = createRelayFixture(60_000)
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
    const request = fixture.provider.addWorktree('/repo', 'feature', '/repo-feature').then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      }
    )

    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled).toBe('pending')
    expect(fixture.operation.running).toBe(true)

    await vi.advanceTimersByTimeAsync(29_999)
    await request
    expect(settled).toBe('resolved')
    expect(fixture.operation).toMatchObject({ running: false, completed: true })
    fixture.mux.dispose()
  })

  it('uses the environment override for the same relay operation budget', async () => {
    vi.useFakeTimers({ now: 0 })
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', '300000')
    const fixture = createRelayFixture(240_000)
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
    const request = fixture.provider.addWorktree('/repo', 'feature', '/repo-feature').then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      }
    )

    await vi.advanceTimersByTimeAsync(180_001)
    expect(settled).toBe('pending')
    expect(fixture.operation.running).toBe(true)

    await vi.advanceTimersByTimeAsync(59_999)
    await request
    expect(settled).toBe('resolved')
    expect(fixture.operation).toMatchObject({ running: false, completed: true })
    fixture.mux.dispose()
  })
})
