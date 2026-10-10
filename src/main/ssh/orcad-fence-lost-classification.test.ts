import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execOrcadStateMutation } from './orcad-state-mutation-exec'
import { execOrcadRemote, execOrcadRemoteOr } from './orcad-remote-runtime-control'
import {
  ORCAD_FENCE_LOST_MARKER,
  OrcadFenceLostError,
  isOrcadFenceLost,
  posixOrcadFenceGuard,
  runWithOrcadFence
} from './orcad-activation-fence-scope'
import { isUnconfirmedSshCommandTermination, sshCommandExitError } from './ssh-relay-exec-command'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

/** An ssh2 exec channel; the host never acknowledges a close, as when the link is down. */
class HostChannel extends EventEmitter {
  readonly stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  readonly stdin = this
  close(): void {}
  resume(): void {}
  exit(code: number, stdout: string): void {
    this.emit('data', Buffer.from(stdout))
    this.emit('close', code)
  }
}

let channel: HostChannel
const commands: string[] = []
const conn = {
  exec: async (command: string) => {
    commands.push(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand reads only the channel events, close() and resume() HostChannel implements.
    return channel as unknown as ClientChannel
  },
  usesSystemSshTransport: () => false
}
const target = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec and usesSystemSshTransport are read.
  conn: conn as unknown as SshConnection,
  host: getRemoteHostPlatform('linux-x64')
}
const fence = {
  lockDir: '/home/u/.orca-remote/.orcad-activation-transaction/.install-lock',
  token: 't1'
}

// As serializedStateMutationCommand builds it: the guard leads the mutation.
const mutation = `${posixOrcadFenceGuard(fence)} restore`

function fenced<T>(run: () => Promise<T>): Promise<T> {
  return runWithOrcadFence(fence, run)
}

async function settledAfter(step: Promise<unknown>, answer: () => void): Promise<unknown> {
  const settled = step.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  answer()
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new HostChannel()
  commands.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

// Round 13: the real exec error quotes the command, and every fenced command carries the marker.
describe('a fenced step through the real exec', () => {
  it('stays an ordinary failure when the step itself exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execOrcadRemote(target, 'false')),
      () => channel.exit(1, 'boom\n')
    )
    expect(commands[0]).toContain(ORCAD_FENCE_LOST_MARKER)
    expect(error).not.toBeInstanceOf(OrcadFenceLostError)
    expect(error).toMatchObject({ exitCode: 1, stdout: 'boom\n' })
  })

  it('lets a failed step fall back', async () => {
    const answer = await settledAfter(
      fenced(() => execOrcadRemoteOr(target, 'false', 'FALLBACK')),
      () => channel.exit(1, '')
    )
    expect(answer).toBe('FALLBACK')
  })

  it('keeps a timed-out step unconfirmed, so the fence is not released under it', async () => {
    const settled = fenced(() => execOrcadRemoteOr(target, 'sleep 99', 'FALLBACK')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).not.toBeInstanceOf(OrcadFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execOrcadRemote(target, 'true')),
      () => channel.exit(75, `${ORCAD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(OrcadFenceLostError)
  })

  it('does not read a marker-free exit 75 as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execOrcadRemote(target, 'true')),
      () => channel.exit(75, 'other\n')
    )
    expect(error).not.toBeInstanceOf(OrcadFenceLostError)
  })
})

describe('a fenced state mutation through the real exec', () => {
  it('stays an ordinary failure when the mutation exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execOrcadStateMutation(target, mutation)),
      () => channel.exit(2, 'no snapshot\n')
    )
    expect(error).not.toBeInstanceOf(OrcadFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(false)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execOrcadStateMutation(target, mutation)),
      () => channel.exit(75, `${ORCAD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(OrcadFenceLostError)
  })
})

describe('a Windows host op whose exit PowerShell flattened to 1', () => {
  it('is a lost fence only when the host script printed the marker', () => {
    const op = `powershell.exe -Command "& 'node.exe' 'host.js' --fence d t ${ORCAD_FENCE_LOST_MARKER}"`
    expect(isOrcadFenceLost(sshCommandExitError(op, 1, `${ORCAD_FENCE_LOST_MARKER}\r\n`))).toBe(
      true
    )
    expect(isOrcadFenceLost(sshCommandExitError(op, 1, 'ENOENT\r\n'))).toBe(false)
  })
})
