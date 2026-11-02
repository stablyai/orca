import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindSalvageObserver } from './salvage-observation'
import { operationModuleLoader } from './operation-module-loader'

const root = resolve(import.meta.dirname, '../../../..')

// The corpus has no salvaged reads; pin reporting directly so a dropped hook cannot pass every golden.
describe('salvaged reads', () => {
  it('records what a real reply schema dropped, and nothing when it dropped nothing', () => {
    const modules = operationModuleLoader(root)
    const { classifyRpcReply } = modules.load<{
      classifyRpcReply: (operation: unknown, response: unknown) => unknown
    }>('mobile/src/transport/rpc-operation-reply.ts')
    const { gitStatusHostPayloadRead } = modules.load<{
      gitStatusHostPayloadRead: { operation: unknown }
    }>('mobile/src/source-control/mobile-git-read-operations.ts')
    const observed: { name: string; value: unknown }[] = []
    bindSalvageObserver((name, value) => observed.push({ name, value }))
    try {
      // Drop one malformed optional and one row while keeping the enclosing reply readable.
      classifyRpcReply(gitStatusHostPayloadRead.operation, {
        ok: true,
        result: {
          entries: [
            { path: 'a', status: 'modified', area: 'worktree' },
            { status: 'modified', area: 'worktree' }
          ],
          branch: 42
        }
      })
      expect(observed).toEqual([
        {
          name: 'reply-salvage',
          value: {
            operation: 'git.status-host-payload',
            method: 'git.status',
            variant: 'host-status-payload',
            droppedPaths: ['1', 'branch'],
            droppedCount: 2
          }
        }
      ])
      observed.length = 0
      classifyRpcReply(gitStatusHostPayloadRead.operation, {
        ok: true,
        result: { entries: [{ path: 'a', status: 'modified', area: 'worktree' }], branch: 'main' }
      })
      expect(observed).toEqual([])
    } finally {
      bindSalvageObserver(() => {})
    }
  })
})
