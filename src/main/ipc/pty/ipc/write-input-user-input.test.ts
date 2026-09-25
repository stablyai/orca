import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-user-input'

const { provider } = vi.hoisted(() => ({
  provider: { write: vi.fn(), hasPty: vi.fn(() => true) }
}))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

function createWriteInput(facts: TerminalRunFactsRegister) {
  const runtime = { getDriver: () => ({ kind: 'desktop' }), terminalRunFacts: facts }
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: write input reads only getDriver and terminalRunFacts from the runtime, and isDestroyed/webContents from the window.
  return createPtyWriteInput({ mainWindow: mainWindow as never, runtime: runtime as never })
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  provider.write.mockReset()
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
})

describe('renderer PTY writes: user input', () => {
  it.each(['writePtyInput', 'writePtyInputAccepted'] as const)(
    '%s records tagged input before the provider write',
    async (writer) => {
      const facts = new TerminalRunFactsRegister()
      facts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'inc-1' })
      const recordedAtWrite: (number | null)[] = []
      provider.write.mockImplementation(() => {
        recordedAtWrite.push(facts.read(PTY_ID, 'inc-1').firstUserInputAt)
      })

      await createWriteInput(facts)[writer]({ id: PTY_ID, data: 'exit\r', userInput: true })

      expect(recordedAtWrite).toEqual([expect.any(Number)])
    }
  )

  it('records nothing for an untagged write', async () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'inc-1' })

    await createWriteInput(facts).writePtyInput({ id: PTY_ID, data: 'echo startup\r' })

    expect(provider.write).toHaveBeenCalledOnce()
    expect(facts.read(PTY_ID, 'inc-1').firstUserInputAt).toBeNull()
  })
})
