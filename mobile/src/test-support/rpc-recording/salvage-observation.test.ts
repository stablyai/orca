import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindSalvageObserver } from './salvage-observation'
import { operationModuleLoader } from './operation-module-loader'

const root = resolve(import.meta.dirname, '../../../..')

/**
 * The observation fires on no golden in the corpus — every checked read in all 727 decodes its
 * reply whole — so this is what pins it. Without it a refactor could stop reporting salvaged reads
 * and every golden would still compare clean, the same reason `unhandled-recording.test.ts` exists.
 */
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
      // `branch` is a salvaged optional and the second entry has no `path`: one member and one row
      // leave the payload, and the reply still decodes.
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
