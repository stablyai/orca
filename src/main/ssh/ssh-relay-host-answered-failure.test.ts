import { describe, expect, it } from 'vitest'
import {
  RemoteNodeRuntimeSecurityModifiedError,
  RemoteNodeRuntimeSelfTestError
} from './orcad-remote-node-runtime-report'
import { isAnsweredHostFailure, RelayHostAnsweredError } from './ssh-relay-host-answered-failure'
import { SSH_EXEC_TIMEOUT_CODE } from './ssh-relay-exec-command'
import { SystemSshCommandExitError } from './system-ssh-operation-lifecycle'

const exitError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { exitCode: code, stdout: '' })

describe('isAnsweredHostFailure', () => {
  it.each([
    ['tar ENOSPC', exitError(2, 'tar: write error: No space left on device')],
    ['extract marker', exitError(1, 'ORCA_NODE_RUNTIME_EXTRACT_FAILED')],
    ['hash mismatch marker', exitError(1, 'ORCA_NODE_RUNTIME_HASH_MISMATCH')],
    ['SFTP write failure', Object.assign(new Error('Failure'), { code: 4 })],
    ['SFTP permission denied', Object.assign(new Error('Permission denied'), { code: 3 })],
    ['unverified promote', new RelayHostAnsweredError('The host did not verify the runtime')],
    ['unclassified self-test', new RemoteNodeRuntimeSelfTestError(1, 'boom')],
    ['security modified', new RemoteNodeRuntimeSecurityModifiedError('node.exe')],
    ['system ssh exit', new SystemSshCommandExitError('promote', 1, 'Access denied')]
  ])('steps down on an answered %s', (_label, error) => {
    expect(isAnsweredHostFailure(error)).toBe(true)
  })

  it.each([
    ['abort', Object.assign(new Error('cancelled'), { name: 'AbortError' })],
    [
      'channel open failure',
      Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 })
    ],
    ['session limit', Object.assign(new Error('open failed'), { reason: 4 })],
    ['timeout', Object.assign(new Error('timed out'), { code: SSH_EXEC_TIMEOUT_CODE })],
    [
      'unconfirmed termination',
      Object.assign(exitError(1, 'lost'), { sshChannelCloseConfirmed: false })
    ],
    ['SFTP connection lost', Object.assign(new Error('Connection lost'), { code: 7 })],
    ['system ssh transport', new SystemSshCommandExitError('promote', 255, 'Connection reset')],
    ['system ssh signal', new SystemSshCommandExitError('promote', null, '')],
    ['plain error', new Error('something else')]
  ])('stays retryable on %s', (_label, error) => {
    expect(isAnsweredHostFailure(error)).toBe(false)
  })
})
