import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch, HANDLER_COMMAND_KEYS } from './dispatch'
import type { RuntimeClient } from './runtime-client'
import { COMMAND_SPECS } from './specs'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Maestro authoring CLI command', () => {
  it('dispatches an authoring payload to the document authoring RPC', async () => {
    const payload = {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: 'author-note-1',
      scope: {
        repository_id: 'repo-1',
        execution_host_id: 'local',
        workspace_key: 'folder:folder-1',
        run_id: 'run-1'
      },
      expected_revision: 0,
      operation: {
        kind: 'create-note',
        node_id: 'note-1',
        position: { x: 10, y: 20 },
        title: 'Bootstrap note',
        markdown: '# Bootstrap'
      }
    }
    const call = vi.fn().mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { outcome: 'applied', revision: 1 },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(COMMAND_SPECS.some(({ path }) => path.join(' ') === 'maestro author')).toBe(true)
    expect(HANDLER_COMMAND_KEYS.has('maestro author')).toBe(true)
    await dispatch(['maestro', 'author'], {
      flags: new Map([['payload', JSON.stringify(payload)]]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/workspace',
      json: true
    })

    expect(call).toHaveBeenCalledWith('maestro.document.authoring.apply', payload)
  })
})
