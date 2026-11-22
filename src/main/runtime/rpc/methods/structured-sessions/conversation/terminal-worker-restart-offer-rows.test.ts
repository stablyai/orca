import { describe, expect, it, vi } from 'vitest'
import {
  continueRestartOffers,
  dismissRestartOffers,
  listRestartOffers
} from './terminal-worker-restart-offer-rows'

const chatRow = { sessionId: 'chat-1', agent: 'claude' }
const workerRow = { sessionId: 'ctx_worker', agent: 'claude' }

function offers() {
  const restartResume = {
    list: vi.fn(async () => [chatRow]),
    listFailures: vi.fn(async () => []),
    dismiss: vi.fn(async (ids?: readonly string[]) => ids?.length ?? 1),
    continueAfterRestart: vi.fn(async () => ({
      resumed: [],
      continued: [{ sessionId: 'chat-1', outcome: 'continued' as const }]
    }))
  }
  const terminalWorkerRestartOffers = {
    list: vi.fn(() => [workerRow]),
    owned: (ids: readonly string[] | undefined) =>
      (ids ?? ['ctx_worker']).filter((id) => id === 'ctx_worker'),
    continue: vi.fn(async (ids: readonly string[]) =>
      ids.map((sessionId) => ({ sessionId, outcome: 'continued' as const }))
    ),
    dismiss: vi.fn((ids: readonly string[]) => ids.length)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these helpers read only the methods stubbed here.
  const host = { restartResume } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const runtime = { terminalWorkerRestartOffers } as never
  return { host, runtime, restartResume, terminalWorkerRestartOffers }
}

describe('restart offers shared by cut chats and offered terminal workers', () => {
  it('lists offered workers beside the cut chats', async () => {
    const { host, runtime } = offers()
    await expect(listRestartOffers(runtime, host, undefined)).resolves.toEqual([chatRow, workerRow])
  })

  it('sends each named id to its own owner when resumed or dismissed', async () => {
    const { host, runtime, restartResume, terminalWorkerRestartOffers } = offers()
    const answer = await continueRestartOffers(
      runtime,
      host,
      ['chat-1', 'ctx_worker'],
      'me',
      undefined
    )
    expect(restartResume.continueAfterRestart).toHaveBeenCalledWith(['chat-1'], 'me', undefined)
    expect(terminalWorkerRestartOffers.continue).toHaveBeenCalledWith(['ctx_worker'])
    expect(answer.continued.map((entry) => entry.sessionId)).toEqual(['chat-1', 'ctx_worker'])

    await expect(dismissRestartOffers(runtime, host, ['ctx_worker'], undefined)).resolves.toBe(1)
    expect(restartResume.dismiss).not.toHaveBeenCalled()
    expect(terminalWorkerRestartOffers.dismiss).toHaveBeenCalledWith(['ctx_worker'])
  })

  it('dismisses every shown chat and worker when no id is named', async () => {
    const { host, runtime, restartResume, terminalWorkerRestartOffers } = offers()
    await dismissRestartOffers(runtime, host, undefined, undefined)
    expect(restartResume.dismiss).toHaveBeenCalledWith(undefined, undefined)
    expect(terminalWorkerRestartOffers.dismiss).toHaveBeenCalledWith(['ctx_worker'])
  })
})
