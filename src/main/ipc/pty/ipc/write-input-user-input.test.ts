import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../../../runtime/terminal/lifecycle/terminal-run-facts'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

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
    noteRemoteDesktopHostInput: vi.fn(),
    notePtyInput: () => {}
  }
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubs implement every runtime and window member this writer reads.
  return createPtyWriteInput({ mainWindow: mainWindow as never, runtime: runtime as never })
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, 'local')
  provider.write.mockReset()
  provider.writeWithSettlement.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  ptyOwnership.delete(PTY_ID)
})

describe('renderer PTY writes: input kind', () => {
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
