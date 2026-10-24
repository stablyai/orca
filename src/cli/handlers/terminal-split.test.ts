import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import type { CliStatusResult } from '../../shared/runtime-types'
import { TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { TERMINAL_HANDLERS } from './terminal'

function splitClient(
  call: RuntimeClient['call'],
  capabilities: NonNullable<CliStatusResult['runtime']['capabilities']>
): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-split-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  vi.spyOn(client, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: true, pid: 123 },
      runtime: { state: 'ready', reachable: true, runtimeId: 'runtime-1', capabilities },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  return client
}

function retrySplit(client: RuntimeClient, splitId = 'leaf-1') {
  return TERMINAL_HANDLERS['terminal split']({
    flags: new Map([
      ['terminal', 'term_1'],
      ['command', 'agent --task 1'],
      ['retry-split', splitId]
    ]),
    client,
    cwd: '/tmp/worktree',
    json: true
  })
}

describe('terminal split --retry-split', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the retry to a host that can resume the split', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { split: { handle: 'term_2', tabId: 'tab-1', paneRuntimeId: 1, leafId: 'leaf-1' } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await retrySplit(splitClient(call, [TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY]))

    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.split', {
      terminal: 'term_1',
      direction: undefined,
      command: 'agent --task 1',
      retrySplit: 'leaf-1'
    })
  })

  // An older host strips `retrySplit` and splits again, starting a second copy of the command.
  it('refuses rather than splitting again on a host without the capability', async () => {
    const call = vi.fn()

    await expect(retrySplit(splitClient(call, []))).rejects.toThrow(
      /does not support --retry-split/
    )
    expect(call).not.toHaveBeenCalled()
  })

  // An unset shell variable gives a blank id; dropping it would split again and re-run --command.
  it('refuses a blank retry id instead of making a fresh split', async () => {
    const call = vi.fn()

    await expect(
      retrySplit(splitClient(call, [TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY]), '')
    ).rejects.toThrow(/--retry-split/)
    expect(call).not.toHaveBeenCalled()
  })
})
