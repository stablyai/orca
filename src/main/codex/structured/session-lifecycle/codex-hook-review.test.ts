import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { reviewCodexHooks } from './codex-hook-review'

const hook = {
  key: 'project:pre-tool',
  currentHash: 'reviewed-hash',
  command: 'printf approved',
  handlerType: 'command',
  eventName: 'preToolUse',
  source: 'project',
  sourcePath: '/project/.codex/hooks.json',
  enabled: false,
  isManaged: false,
  trustStatus: 'untrusted',
  timeoutSec: 10
}

describe('Codex hook review', () => {
  it('persists only the reviewed hash and verifies trust without enabling a disabled hook', async () => {
    let state: Record<string, unknown> = { unrelated: { enabled: false } }
    const request = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'hooks/list') {
        return {
          data: [
            {
              cwd: '/project',
              hooks: [
                { ...hook, trustStatus: 'project:pre-tool' in state ? 'trusted' : 'untrusted' }
              ],
              errors: [],
              warnings: []
            }
          ]
        }
      }
      if (method === 'config/batchWrite') {
        const [edit] = z
          .array(z.object({ keyPath: z.string(), value: z.record(z.string(), z.unknown()) }))
          .min(1)
          .parse(params?.edits)
        if (edit.keyPath !== 'hooks.state') {
          throw new Error('Unexpected config path')
        }
        state = { ...state, ...edit.value }
        return {}
      }
      throw new Error(`Unexpected method: ${method}`)
    }
    const result = await reviewCodexHooks(request, { cwds: ['/project'] }, 'scope', false, {
      scope: 'scope',
      key: 'project:pre-tool',
      currentHash: 'reviewed-hash'
    })
    expect(state).toEqual({
      unrelated: { enabled: false },
      'project:pre-tool': { trusted_hash: 'reviewed-hash' }
    })
    expect(result.hooks[0]).toMatchObject({ enabled: false, trustStatus: 'trusted' })
  })

  it.each([
    { label: 'changed command', changes: { currentHash: 'new-hash' }, scope: 'scope' },
    { label: 'changed account or thread', changes: {}, scope: 'another-scope' },
    { label: 'managed hook', changes: { isManaged: true }, scope: 'scope' },
    { label: 'unsupported handler', changes: { handlerType: 'prompt' }, scope: 'scope' },
    { label: 'missing hook', changes: { key: 'another-hook' }, scope: 'scope' }
  ])('refuses $label before writing any configuration', async ({ changes, scope }) => {
    let written = false
    const request = async (method: string) => {
      if (method === 'config/batchWrite') {
        written = true
      }
      return {
        data: [{ cwd: '/project', hooks: [{ ...hook, ...changes }], warnings: [], errors: [] }]
      }
    }
    await expect(
      reviewCodexHooks(request, { cwds: ['/project'] }, scope, false, {
        scope: 'scope',
        key: 'project:pre-tool',
        currentHash: 'reviewed-hash'
      })
    ).rejects.toThrow()
    expect(written).toBe(false)
  })
})
