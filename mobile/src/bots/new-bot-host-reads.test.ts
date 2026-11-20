import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { readBotAgentChoices } from './new-bot-host-reads'

// Every call the read makes fails, as on a computer that can't be reached.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a client whose every member rejects.
const failing = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('offline')
    }
  }
) as RpcClient

describe('the agents a computer offers New bot', () => {
  it('marks every agent check failed when the computer cannot be asked, offering none', async () => {
    const rows = await readBotAgentChoices(failing)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.unavailable === 'check-failed')).toBe(true)
  })
})
