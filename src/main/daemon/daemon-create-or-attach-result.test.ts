import { describe, expect, it } from 'vitest'
import { toDaemonCreateOrAttachResult } from './daemon-create-or-attach-result'
import type { CreateOrAttachResult } from './terminal-host-create-contract'

function createResult(shellPath?: string): CreateOrAttachResult {
  return {
    isNew: true,
    snapshot: null,
    pid: 42,
    ...(shellPath ? { shellPath } : {}),
    shellState: 'ready',
    wslDistro: null,
    attachToken: Symbol('private'),
    incarnationId: '11111111-1111-4111-8111-111111111111'
  }
}

describe('daemon create-or-attach wire result', () => {
  it('publishes the process owner shell without leaking private host state', () => {
    expect(
      toDaemonCreateOrAttachResult(createResult('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
    ).toEqual({
      isNew: true,
      snapshot: null,
      pid: 42,
      shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      shellState: 'ready',
      incarnationId: '11111111-1111-4111-8111-111111111111',
      wslDistro: null
    })
  })

  it('keeps the additive shell field absent for older owners', () => {
    expect(toDaemonCreateOrAttachResult(createResult())).not.toHaveProperty('shellPath')
  })
})
