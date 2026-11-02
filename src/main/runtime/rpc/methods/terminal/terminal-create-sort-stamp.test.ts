import '../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { DESKTOP_RPC_CALLER } from '../../rpc-caller-identity'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcDispatchStreamingOptions } from '../../dispatcher-stream-options'
import { TERMINAL_LIFECYCLE_METHODS } from './terminal-lifecycle-methods'

vi.mock('../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

const WT = 'repo-1::/tmp/a'

function makeHost(created: { isReattach?: true } = {}) {
  const noteTerminalStarted = vi.fn()
  const fake = {
    getRuntimeId: () => 'test-runtime',
    dedupeTerminalCreate: async () => ({
      handle: 'term-1',
      worktreeId: WT,
      title: null,
      ...created
    }),
    sidebarFacts: { sortStamps: { noteTerminalStarted } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.create reads only the members above.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_LIFECYCLE_METHODS })
  const create = (context: RpcDispatchStreamingOptions) =>
    dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'terminal.create',
        params: { worktree: `id:${WT}` }
      },
      context
    )
  return { create, noteTerminalStarted }
}

describe('terminal.create sort stamp', () => {
  it('stamps a terminal the CLI starts', async () => {
    const host = makeHost()
    await expect(host.create({})).resolves.toMatchObject({ ok: true })
    expect(host.noteTerminalStarted).toHaveBeenCalledWith(WT, undefined)
  })

  it('leaves a terminal a person opens in a window or on a phone, and a reattach', async () => {
    const window = makeHost()
    await window.create({ caller: DESKTOP_RPC_CALLER })
    const phone = makeHost()
    await phone.create({ clientKind: 'mobile', pairedDeviceId: 'phone-1' })
    const reattach = makeHost({ isReattach: true })
    await reattach.create({})
    expect(window.noteTerminalStarted).not.toHaveBeenCalled()
    expect(phone.noteTerminalStarted).not.toHaveBeenCalled()
    expect(reattach.noteTerminalStarted).not.toHaveBeenCalled()
  })
})
