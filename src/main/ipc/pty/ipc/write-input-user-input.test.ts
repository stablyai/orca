import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'

const PTY_ID = 'pty-user-input'

const { provider } = vi.hoisted(() => ({
  provider: {
    write: vi.fn(),
    hasPty: vi.fn(() => true),
    writeWithSettlement:
      vi.fn<(id: string, data: string) => WriteSettlement | Promise<WriteSettlement>>()
  }
}))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

function createWriteInput(
  facts: TerminalRunFactsRegister,
  observeClaudeTerminalEvidence = vi.fn()
) {
  const runtime = {
    getDriver: () => ({ kind: 'desktop' }),
    terminalRunFacts: facts,
    observeClaudeTerminalEvidence,
    noteRemoteDesktopHostInput: vi.fn()
  }
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubs implement every runtime and window member this writer reads.
  return createPtyWriteInput({ mainWindow: mainWindow as never, runtime: runtime as never })
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  provider.write.mockReset()
  provider.writeWithSettlement.mockReset()
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
})

describe('renderer PTY writes: input kind', () => {
  it.each([null, 'ssh-connection'])(
    'observes a settled write only after acceptance on the execution host (%s)',
    async (owner) => {
      ptyOwnership.set(PTY_ID, owner)
      const observe = vi.fn()
      const input = createWriteInput(new TerminalRunFactsRegister(), observe)
      let finish: (settlement: WriteSettlement) => void = () => {}
      provider.writeWithSettlement.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      const args = {
        id: PTY_ID,
        data: '\x1b[27u',
        inputKind: 'driving' as const,
        requireWriteSettlement: true as const
      }
      const pending = input.writePtyInputAccepted(args)
      expect(observe).not.toHaveBeenCalled()
      finish(WRITE_ACCEPTED)
      expect(await pending).toBe(true)
      expect(observe).toHaveBeenCalledTimes(owner === null ? 1 : 0)
      observe.mockClear()
      provider.writeWithSettlement.mockReturnValueOnce(writeRefused('endpoint_disconnected'))
      expect(await input.writePtyInputAccepted(args)).toBe(false)
      provider.writeWithSettlement.mockResolvedValueOnce(
        writeUnverifiable('transport_settlement_lost', true)
      )
      await expect(input.writePtyInputAccepted(args)).rejects.toThrow('acknowledgment unavailable')
      expect(observe).not.toHaveBeenCalled()
      expect(provider.write).not.toHaveBeenCalled()
    }
  )

  it.each(['writePtyInput', 'writePtyInputAccepted'] as const)(
    '%s observes Escape only after a successful local write',
    async (writer) => {
      const observe = vi.fn()
      const input = createWriteInput(new TerminalRunFactsRegister(), observe)
      provider.write.mockImplementation(() => {
        expect(observe).not.toHaveBeenCalled()
        return true
      })
      expect(await input[writer]({ id: PTY_ID, data: '\x1b', inputKind: 'driving' })).toBe(true)
      expect(observe).toHaveBeenCalledWith(PTY_ID, { kind: 'input', data: '\x1b' })
      observe.mockClear()
      provider.write.mockReturnValue(false)
      expect(await input[writer]({ id: PTY_ID, data: '\x1b', inputKind: 'driving' })).toBe(false)
      expect(observe).not.toHaveBeenCalled()
      provider.write.mockImplementation(() => {
        throw new Error('PTY unavailable')
      })
      expect(await input[writer]({ id: PTY_ID, data: '\x1b', inputKind: 'driving' })).toBe(false)
      expect(observe).not.toHaveBeenCalled()
    }
  )

  it('does not turn a client-side SSH handoff into host evidence', async () => {
    ptyOwnership.set(PTY_ID, 'ssh-connection')
    const observe = vi.fn()
    const input = createWriteInput(new TerminalRunFactsRegister(), observe)
    expect(await input.writePtyInput({ id: PTY_ID, data: '\x1b', inputKind: 'driving' })).toBe(true)
    expect(observe).not.toHaveBeenCalled()
  })

  it.each(['writePtyInput', 'writePtyInputAccepted'] as const)(
    '%s records driving input before the provider write',
    async (writer) => {
      const facts = new TerminalRunFactsRegister()
      facts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'inc-1' })
      const recordedAtWrite: (number | null)[] = []
      provider.write.mockImplementation(() => {
        recordedAtWrite.push(facts.read(PTY_ID, 'inc-1').firstUserInputAt)
      })

      await createWriteInput(facts)[writer]({ id: PTY_ID, data: 'exit\r', inputKind: 'driving' })

      expect(recordedAtWrite).toEqual([expect.any(Number)])
    }
  )

  it.each([
    ['a launch write', 'launch', 'echo startup\r'],
    ['a query reply', 'query-reply', '\x1b[3;4R'],
    ['a driving write that is only a reply', 'driving', '\x1b[3;4R'],
    ['a driving write that is only focus reports', 'driving', '\x1b[I\x1b[O']
  ] as const)('records nothing for %s', async (_label, inputKind, data) => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'inc-1' })

    await createWriteInput(facts).writePtyInput({ id: PTY_ID, data, inputKind })

    expect(provider.write).toHaveBeenCalledOnce()
    expect(facts.read(PTY_ID, 'inc-1').firstUserInputAt).toBeNull()
  })
})
