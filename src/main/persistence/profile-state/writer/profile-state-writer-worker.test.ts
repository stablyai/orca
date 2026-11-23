import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProfileStateSqliteAuthority } from '../profile-state-sqlite-authority'

import { openProfileStateDatabase } from '../database/profile-state-database'
import { readProfileStateSnapshot } from '../documents/profile-state-documents'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'
import { ProfileStateWorkerAuthority } from '../profile-state-worker-authority'
import type { ProfileStateSaveNotice } from '../../../../shared/orca-profiles/profile-state-save-notice'

let bundleRoot: string
let workerPath: string
const roots: string[] = []
const clients: ProfileStateWriteWorkerClient[] = []

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-writer-bundle-'))
  workerPath = join(bundleRoot, 'profile-state-writer-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts')
    ],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-writer-'))
  roots.push(root)
  const path = join(root, 'profile-state.db')
  const profileId = 'writer-test'
  const db = openProfileStateDatabase(path, profileId)
  db.db.close()
  const authority = new ProfileStateSqliteAuthority(path, profileId)
  authority.readInitialState().takeParsedState?.()
  authority.writeCompleteSerializedDomains([{ domain: 'settings', payload: '{"theme":"dark"}' }])
  const initialization = authority.retireForWorker()
  return { root, path, profileId, authority, initialization }
}

function clientFor(
  initialization: ReturnType<typeof fixture>['initialization'],
  path = workerPath,
  slowWarningMs = 5000
) {
  const client = new ProfileStateWriteWorkerClient(initialization, {
    workerPath: path,
    slowWarningMs
  })
  clients.push(client)
  return client
}

function readState(path: string, profileId: string): unknown {
  const db = openProfileStateDatabase(path, profileId)
  try {
    return JSON.parse(readProfileStateSnapshot(db.db).json)
  } finally {
    db.db.close()
  }
}

function script(root: string, source: string): string {
  const path = join(root, 'fault-worker.cjs')
  writeFileSync(path, source)
  return path
}

describe('persistent profile state write worker', () => {
  it('commits full, selective, automation and byte payloads, exports and releases the database', async () => {
    const f = fixture()
    const client = clientFor(f.initialization)
    await client.ready
    expect(
      await client.writeSerializedDomains([{ domain: 'ui', payload: '{"note":"hi \\ud800"}' }])
    ).toBe(2)
    const run = {
      id: 'run-1',
      output: 'first',
      toJSON() {
        return { id: this.id, output: this.output }
      }
    }
    const write = client.writeSerializedAutomationRuns([], [run])
    run.output = 'changed after capture'
    expect(await write).toBe(3)
    const exported = join(f.root, 'state.json')
    expect(await client.writeJsonExport(exported)).toBe(3)
    expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual({
      settings: { theme: 'dark' },
      ui: { note: 'hi \ud800' },
      automationRuns: [{ id: 'run-1', output: 'first' }]
    })
    const dataFile = join(f.root, 'orca-data.json')
    expect(await client.writeLatestJsonExport(dataFile)).toBe(3)
    expect(readFileSync(`${dataFile}.sqlite-export.3.json`, 'utf8')).toBe(
      readFileSync(exported, 'utf8')
    )
    expect(existsSync(dataFile)).toBe(false)
    expect(await client.writeSerializedState(Buffer.from('{"settings":{"theme":"light"}}'))).toBe(4)
    expect(await client.assertCurrentRevision()).toBe(4)
    await client.close()
    await client.close()
    expect(readState(f.path, f.profileId)).toEqual({ settings: { theme: 'light' } })
    rmSync(f.root, { recursive: true })
    expect(existsSync(f.root)).toBe(false)
  })

  it('reports post-commit worker death as indeterminate without replaying the committed write', async () => {
    const f = fixture()
    const crashAfterCommit = script(
      f.root,
      `
      const { MessagePort } = require('node:worker_threads')
      const send = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function(value, ...rest) {
        if (value?.id === 1 && value.ok) process.exit(13)
        return send.call(this, value, ...rest)
      }
      require(${JSON.stringify(workerPath)})
    `
    )
    const client = clientFor(f.initialization, crashAfterCommit)
    await client.ready
    const failure = await client
      .writeSerializedDomains([{ domain: 'settings', payload: '{"committed":true}' }])
      .catch((error: unknown) => error)
    expect(profileStateWriterFailureOutcome(failure)).toBe('indeterminate')
    await expect(client.assertCurrentRevision()).rejects.toBe(failure)
    await client.close()
    expect(readState(f.path, f.profileId)).toEqual({ settings: { committed: true } })
  })

  it('recovers the prior committed revision after the worker exits inside a transaction', async () => {
    const f = fixture()
    const interruptedPath = join(f.root, 'interrupted-worker.cjs')
    await build({
      entryPoints: [
        resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts')
      ],
      outfile: interruptedPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'interrupt-transaction',
          setup(builder) {
            builder.onLoad({ filter: /profile-state-write-transaction\.ts$/ }, (args) => ({
              contents: readFileSync(args.path, 'utf8').replace(
                "db.exec('COMMIT')",
                'process.exit(17)'
              ),
              loader: 'ts'
            }))
          }
        }
      ]
    })
    const client = clientFor(f.initialization, interruptedPath)
    await client.ready
    const failure = await client
      .writeSerializedDomains([{ domain: 'settings', payload: '{"uncommitted":true}' }])
      .catch((error: unknown) => error)
    expect(profileStateWriterFailureOutcome(failure)).toBe('indeterminate')
    await client.close()
    expect(readState(f.path, f.profileId)).toEqual({ settings: { theme: 'dark' } })
  })

  async function interruptedAuthority(
    root: string,
    f: ReturnType<typeof fixture>,
    mode: 'before-commit' | 'after-commit' | 'disk-full' | 'refused',
    reported: { failures: Error[]; notices: ProfileStateSaveNotice[] },
    writerIdleStopMs?: number
  ) {
    const interruptedPath = join(root, 'interrupted-worker.cjs')
    const marker = JSON.stringify(join(root, 'interrupted-once'))
    const exitOnce = `if (!require('node:fs').existsSync(${marker})) { require('node:fs').writeFileSync(${marker}, ''); process.exit(17) }`
    await build({
      entryPoints: [
        resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts')
      ],
      outfile: interruptedPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'interrupt-first-transaction',
          setup(builder) {
            builder.onLoad({ filter: /profile-state-write-transaction\.ts$/ }, (args) => ({
              contents: readFileSync(args.path, 'utf8').replace(
                "db.exec('COMMIT')",
                {
                  'before-commit': `${exitOnce}; db.exec('COMMIT')`,
                  'after-commit': `db.exec('COMMIT'); ${exitOnce}`,
                  // SQLite's SQLITE_FULL (13) on COMMIT leaves the transaction open, so it rolls back cleanly.
                  'disk-full': `${exitOnce.replace('process.exit(17)', "throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })")}; db.exec('COMMIT')`,
                  refused: `${exitOnce.replace('process.exit(17)', "throw new Error('database is locked')")}; db.exec('COMMIT')`
                }[mode]
              ),
              loader: 'ts'
            }))
          }
        }
      ]
    })
    const authority = new ProfileStateWorkerAuthority(f.initialization, {
      workerPath: interruptedPath,
      onFailure: (error) => reported.failures.push(error),
      onSaveDelayChanged: (notice) => reported.notices.push(notice),
      writerIdleStopMs
    })
    await authority.ready
    const failure = await authority
      .writeSerializedDomains([{ domain: 'settings', payload: '{"interrupted":true}' }])
      .catch((error: unknown) => error)
    expect(profileStateWriterFailureOutcome(failure)).toBe(
      mode === 'disk-full' || mode === 'refused' ? 'known-failure' : 'indeterminate'
    )
    return authority
  }

  it('reopens after an indeterminate write only when the transaction did not commit', async () => {
    const rolledBack = fixture()
    const recovery: { failures: Error[]; notices: ProfileStateSaveNotice[] } = {
      failures: [],
      notices: []
    }
    const recovered = await interruptedAuthority(
      rolledBack.root,
      rolledBack,
      'before-commit',
      recovery
    )
    await expect(
      recovered.writeSerializedDomains([{ domain: 'settings', payload: '{"recovered":true}' }])
    ).resolves.toBeUndefined()
    // The notice stays up from the interrupted write until a save lands; nothing reports saving stopped.
    expect(recovery).toEqual({ failures: [], notices: ['failing', null] })
    await recovered.close()
    expect(readState(rolledBack.path, rolledBack.profileId)).toEqual({
      settings: { recovered: true }
    })

    const committed = fixture()
    const refusal: { failures: Error[]; notices: ProfileStateSaveNotice[] } = {
      failures: [],
      notices: []
    }
    const refused = await interruptedAuthority(committed.root, committed, 'after-commit', refusal)
    await expect(
      refused.writeSerializedDomains([{ domain: 'settings', payload: '{"overwrite":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-revision-conflict' })
    expect(refusal.failures.map(profileStateWriterFailureOutcome)).toEqual(['indeterminate'])
    expect(refusal.notices).toEqual(['failing', null])
    await refused.close().catch(() => {})
    expect(readState(committed.path, committed.profileId)).toEqual({
      settings: { interrupted: true }
    })
  })

  it('warns about a refused save without claiming a full disk, until a later save lands', async () => {
    const locked = fixture()
    const events: { failures: Error[]; notices: ProfileStateSaveNotice[] } = {
      failures: [],
      notices: []
    }
    const authority = await interruptedAuthority(locked.root, locked, 'refused', events)
    await expect(
      authority.writeSerializedDomains([{ domain: 'settings', payload: '{"saved":true}' }])
    ).resolves.toBeUndefined()
    expect(events).toEqual({ failures: [], notices: ['failing', null] })
    await authority.close()
  })

  it('keeps a writer that is refusing saves open instead of idling it out between retries', async () => {
    const locked = fixture()
    const events: { failures: Error[]; notices: ProfileStateSaveNotice[] } = {
      failures: [],
      notices: []
    }
    const authority = await interruptedAuthority(locked.root, locked, 'refused', events, 20)
    const writer = Reflect.get(authority, 'writer')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(Reflect.get(authority, 'writer')).toBe(writer)
    await authority.close()
  })

  it('keeps the warning up from a disk-full save until a later save lands', async () => {
    const full = fixture()
    const events: { failures: Error[]; notices: ProfileStateSaveNotice[] } = {
      failures: [],
      notices: []
    }
    const authority = await interruptedAuthority(full.root, full, 'disk-full', events)
    expect(events.notices).toEqual(['disk-full'])
    await expect(
      authority.writeSerializedDomains([{ domain: 'settings', payload: '{"saved":true}' }])
    ).resolves.toBeUndefined()
    expect(events).toEqual({ failures: [], notices: ['disk-full', null] })
    await authority.close()
    expect(readState(full.path, full.profileId)).toEqual({ settings: { saved: true } })
  })
})
