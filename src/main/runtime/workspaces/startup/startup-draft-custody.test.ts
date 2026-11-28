import { expect, it, vi } from 'vitest'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { RuntimeTerminalWaiterRegistry } from '../../terminal/wait/terminal-waiter-registry'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'
import { pasteStartupDraftInCustody, type StartupDraftCustodyHost } from './startup-draft-custody'

// The agent is ready by the time this test decides anything; the wait itself is not under test.
vi.mock('./runtime-worktree-startup-readiness', () => ({ waitForWorktreeStartupDraft: vi.fn() }))

it('writes no startup draft once its request ends as the agent becomes ready', async () => {
  const request = new AbortController()
  const writes: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a live PTY record is all custody reads here.
  const target = {
    ptyId: 'pty-1',
    incarnationId: 'incarnation-1',
    connected: true,
    lastExitCode: null
  } as RuntimePtyWorktreeRecord
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: custody reads that record, checks it is live and registers one waiter; this supplies exactly those.
  const host = {
    readiness: {
      getPtyId: () => 'pty-1',
      subscribeToData: () => () => undefined,
      readRecentOutput: () => undefined,
      write: (_ptyId: string, data: string) => writes.push(data)
    },
    waiters: new RuntimeTerminalWaiterRegistry(),
    readPty: () => target,
    lifecycleSignal: () => new AbortController().signal,
    isStopRequested: () => false
  } as unknown as StartupDraftCustodyHost
  // Ready and ended in the same instant: the wait answered before the abort could reach it.
  vi.mocked(waitForWorktreeStartupDraft).mockImplementation(async () => {
    request.abort()
    return 'pty-1'
  })

  pasteStartupDraftInCustody(
    host,
    'term-1',
    { agent: 'claude', content: 'Run the tests.' },
    { signal: request.signal }
  )
  await new Promise((resolve) => setImmediate(resolve))

  expect(writes).toEqual([])
})
