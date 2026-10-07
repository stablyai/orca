import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import {
  ORCAD_STATE_MUTATION_CLIENT_TIMEOUT_MS,
  execOrcadStateMutation,
  execOrcadStateMutationOr
} from './orcad-state-mutation-exec'
import { execOrcadRemoteOr } from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

/** An ssh2 exec channel whose remote command answers only when the test says so. */
class SlowChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly stdin = this
  closed = false
  // sshd acknowledges the close at once, which ssh2 reports as a confirmed close.
  close(): void {
    this.closed = true
    queueMicrotask(() => this.emit('close', 0))
  }
  resume(): void {}
  finish(output: string): void {
    this.emit('data', Buffer.from(output))
    this.emit('close', 0)
  }
}

let channel: SlowChannel
const conn = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand reads only the channel events, close() and resume() SlowChannel implements.
  exec: async () => channel as unknown as ClientChannel,
  usesSystemSshTransport: () => false
}
const target = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec and usesSystemSshTransport are read.
  conn: conn as unknown as SshConnection,
  host: getRemoteHostPlatform('linux-x64')
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new SlowChannel()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a snapshot restore that runs past the 30s exec timeout', () => {
  it('was read as a confirmed failure by the generic exec, though the host kept restoring', async () => {
    const generic = execOrcadRemoteOr(target, 'restore', 'FALLBACK')
    await vi.advanceTimersByTimeAsync(31_000)
    await expect(generic).resolves.toBe('FALLBACK')
    expect(channel.closed).toBe(true)
  })

  it('keeps waiting past 30s and returns the restore’s own answer', async () => {
    const restore = execOrcadStateMutation(target, 'restore')
    await vi.advanceTimersByTimeAsync(45_000)
    expect(channel.closed).toBe(false)
    channel.finish('RESTORED\n')
    await expect(restore).resolves.toBe('RESTORED\n')
  })

  it('treats giving up as unconfirmed, even when sshd confirms the channel close', async () => {
    const restore = execOrcadStateMutationOr(target, 'restore', 'FALLBACK')
    const settled = restore.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(ORCAD_STATE_MUTATION_CLIENT_TIMEOUT_MS + 1_000)
    const error = await settled
    expect(channel.closed).toBe(true)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
  })

  it.each(['STATE_MUTATION_BUSY', 'STATE_MUTATION_DEADLINE'])(
    'reads the host’s %s answer as unconfirmed, never as a failed restore',
    async (answer) => {
      const restore = execOrcadStateMutationOr(target, 'restore', 'FALLBACK')
      await vi.advanceTimersByTimeAsync(0)
      channel.finish(`${answer}\n`)
      const error = await restore.catch((caught: unknown) => caught)
      expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
    }
  )

  it('reads a command that exited non-zero as finished, so the fallback applies', async () => {
    const restore = execOrcadStateMutationOr(target, 'restore', 'FALLBACK')
    await vi.advanceTimersByTimeAsync(0)
    channel.emit('close', 2)
    await expect(restore).resolves.toBe('FALLBACK')
  })
})
