import { describe, expect, it } from 'vitest'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { PI_RPC_BACKGROUND_COMMANDS_CHANNEL, PiRpcChildWorkRoster } from './rpc-child-work-roster'

function commandsFrame(commands: unknown): JsonlRpcRecord {
  return {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'orca-background-commands',
    statusText: JSON.stringify({ commands })
  }
}

describe('PiRpcChildWorkRoster background commands', () => {
  it('reports a listed command as live background command work until it leaves the list', () => {
    const delivered: AgentChildWorkEvidence[][] = []
    const roster = new PiRpcChildWorkRoster(
      (evidence) => delivered.push(evidence),
      PI_RPC_BACKGROUND_COMMANDS_CHANNEL
    )

    expect(
      roster.receive(commandsFrame([{ id: 'proc_1', state: 'working', description: 'pnpm dev' }]))
    ).toBe(true)
    expect(delivered[0]).toMatchObject([
      {
        type: 'live',
        child: {
          handle: { idKind: 'task_id', id: 'command:proc_1' },
          kind: 'command',
          residency: 'background',
          state: 'working',
          description: 'pnpm dev'
        }
      }
    ])

    roster.receive(commandsFrame([]))
    expect(delivered[1]).toMatchObject([
      { type: 'ended', handle: { idKind: 'task_id', id: 'command:proc_1' }, outcome: 'unknown' }
    ])
  })

  it('leaves the subagent status line to the subagent roster', () => {
    const roster = new PiRpcChildWorkRoster(() => {}, PI_RPC_BACKGROUND_COMMANDS_CHANNEL)
    expect(
      roster.receive({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'orca-subagents',
        statusText: '{}'
      })
    ).toBe(false)
  })
})
