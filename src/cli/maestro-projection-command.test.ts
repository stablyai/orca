import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./format', () => ({ printResult: vi.fn() }))

import { MAESTRO_HANDLERS } from './handlers/maestro'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true })
    temporaryDirectory = null
  }
})

describe('public Maestro projection commands', () => {
  it('opens one authoritative Canvas binding by Run', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          entries: [
            {
              executionHostId: 'ssh:build',
              workspaceKey: 'folder:workspace_1',
              projectionRevisions: [{ runId: 'run_1' }]
            }
          ]
        }
      })
      .mockResolvedValueOnce({ result: {} })

    await MAESTRO_HANDLERS['maestro open']({
      flags: new Map([['run', 'run_1']]),
      client: { call },
      cwd: '/repo',
      json: true
    } as never)

    expect(call).toHaveBeenNthCalledWith(1, 'maestro.list')
    expect(call).toHaveBeenNthCalledWith(2, 'maestro.canvas.open', {
      execution_host_id: 'ssh:build',
      workspace_key: 'folder:workspace_1'
    })
  })

  it('routes projection show to the canonical scoped RPC', async () => {
    const call = vi.fn().mockResolvedValue({ result: {} })
    await MAESTRO_HANDLERS['maestro projection show']({
      flags: new Map([
        ['host', 'ssh:build'],
        ['workspace', 'folder:workspace_1']
      ]),
      client: { call },
      cwd: '/repo',
      json: true
    } as never)

    expect(call).toHaveBeenCalledWith('maestro.projection.get', {
      scope: { execution_host_id: 'ssh:build', workspace_key: 'folder:workspace_1' }
    })
  })

  it('routes projection apply and bootstrap payload files to their canonical RPCs', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-maestro-command-'))
    const projection = { workspace: {}, view: {} }
    const bootstrap = { schema_version: 1, protocol: 'maestro-bootstrap/v1' }
    await writeFile(join(temporaryDirectory, 'projection.json'), JSON.stringify(projection), 'utf8')
    await writeFile(join(temporaryDirectory, 'bootstrap.json'), JSON.stringify(bootstrap), 'utf8')
    const call = vi.fn().mockResolvedValue({ result: {} })
    const context = (file: string) =>
      ({
        flags: new Map([['payload-file', file]]),
        client: { call },
        cwd: temporaryDirectory,
        json: true
      }) as never

    await MAESTRO_HANDLERS['maestro projection apply'](context('projection.json'))
    await MAESTRO_HANDLERS['maestro bootstrap'](context('bootstrap.json'))

    expect(call).toHaveBeenNthCalledWith(1, 'maestro.projection.apply', projection)
    expect(call).toHaveBeenNthCalledWith(2, 'maestro.bootstrap', bootstrap)
  })
})
