import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

const clients: ProfileStateWriteWorkerClient[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function clientFor(
  response: string,
  initialization = '{ id: 0, ok: true, revision: 1 }',
  onFailure?: (error: Error) => void,
  startup = ''
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-writer-protocol-'))
  roots.push(root)
  const workerPath = join(root, 'writer.cjs')
  writeFileSync(
    workerPath,
    `
    const { parentPort } = require('node:worker_threads')
    parentPort.postMessage(${initialization})
    parentPort.on('message', (request) => { ${response} })
    ${startup}
  `
  )
  const client = new ProfileStateWriteWorkerClient(
    { databasePath: join(root, 'unused.db'), profileId: 'protocol-test', revision: 1 },
    { workerPath, timeoutMs: 1000, onFailure }
  )
  clients.push(client)
  return client
}

describe('writer protocol refuses uncertain acknowledgements', () => {
  it.each([
    '{ id: request.id + 1, ok: true, revision: 2 }',
    '{ id: request.id, ok: true, revision: 0 }',
    '{ id: request.id, ok: true, revision: 3 }',
    '{ id: request.id, ok: true, revision: 2, exportedRevision: 2 }',
    '{ id: request.id, ok: true, revision: "2" }'
  ])('faults instead of acknowledging malformed write response %s', async (response) => {
    const client = clientFor(`parentPort.postMessage(${response})`)
    await client.ready
    await expect(
      client.writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-protocol', outcome: 'indeterminate' })
    await expect(client.assertCurrentRevision()).rejects.toMatchObject({
      code: 'profile-state-writer-protocol'
    })
  })

  it.each(['undefined', 'null', '0', '2'])(
    'refuses a compatibility export with revision %s for an admitted revision of one',
    async (exportedRevision) => {
      const client = clientFor(`parentPort.postMessage({
        id: request.id, ok: true, revision: 1, exportedRevision: ${exportedRevision}
      })`)
      await client.ready
      await expect(client.writeJsonCompatibilityExportAsync('unused.json')).rejects.toMatchObject({
        code: 'profile-state-writer-protocol',
        outcome: 'indeterminate'
      })
    }
  )

  it('refuses a revision jump at an unchanged-state fence', async () => {
    const client = clientFor('parentPort.postMessage({ id: request.id, ok: true, revision: 2 })')
    await client.ready
    await expect(client.assertCurrentRevision()).rejects.toMatchObject({
      code: 'profile-state-writer-protocol',
      outcome: 'indeterminate'
    })
  })

  it('refuses an initialization acknowledgement for a different revision', async () => {
    const client = clientFor('', '{ id: 0, ok: true, revision: 2 }')
    await expect(client.ready).rejects.toMatchObject({
      code: 'profile-state-writer-protocol',
      outcome: 'known-failure'
    })
  })

  it('faults an unanswered request and rejects later work without retry', async () => {
    const notify = vi.fn()
    const client = clientFor('', undefined, notify)
    await client.ready
    await expect(
      client.writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-timeout', outcome: 'indeterminate' })
    await expect(client.assertCurrentRevision()).rejects.toMatchObject({
      code: 'profile-state-writer-timeout'
    })
    await client.close()
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'profile-state-writer-timeout' })
    )
  })

  it('reports an idle writer exit even without a subsequent save', async () => {
    const notify = vi.fn()
    const client = clientFor('', undefined, notify, 'setTimeout(() => process.exit(1), 50)')
    await client.ready
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'profile-state-writer-exit' })
    )
    await client.close()
    expect(notify).toHaveBeenCalledOnce()
  })

  it('leaves startup failure reporting to the startup caller', async () => {
    const notify = vi.fn()
    const client = clientFor('', '{ id: 0, ok: true, revision: 2 }', notify)
    await expect(client.ready).rejects.toThrow()
    await client.close()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not report saving stopped after a recoverable request failure or clean close', async () => {
    const notify = vi.fn()
    const client = clientFor(
      `
      if (request.command === 'close') {
        parentPort.postMessage({ id: request.id, ok: true, revision: 1 })
        parentPort.close()
      } else {
        parentPort.postMessage({ id: request.id, ok: false,
          error: { code: 'SQLITE_BUSY', message: 'busy', outcome: 'known-failure' } })
      }
    `,
      undefined,
      notify
    )
    await client.ready
    await expect(client.assertCurrentRevision()).rejects.toThrow('busy')
    expect(() => client.assertWritable()).not.toThrow()
    await client.close()
    expect(notify).not.toHaveBeenCalled()
  })
})
