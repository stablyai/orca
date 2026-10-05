import { build } from 'esbuild'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { EditorRecoveryChange, EditorRecoveryMetadata } from '../../shared/editor-recovery'
import { createEditorRecoveryTextPatch } from '../../shared/editor-recovery-text-patch'
import { EditorRecoveryWorker } from './editor-recovery-worker'
import { EditorRecoveryService } from './editor-recovery-service'

let bundleRoot: string
let workerPath: string
const roots: string[] = []
const clients: EditorRecoveryWorker[] = []
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-recovery-worker-bundle-'))
  workerPath = join(bundleRoot, 'editor-recovery-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/editor-recovery/editor-recovery-worker-entry.ts')],
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
  vi.restoreAllMocks()
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-recovery-worker-'))
  roots.push(root)
  return { root, path: join(root, 'editor-recovery.sqlite') }
}
function client(path: string, entry = workerPath, timeout = 15_000, idleMs = 1_000) {
  const result = new EditorRecoveryWorker(path, entry, timeout, idleMs)
  clients.push(result)
  return result
}
function metadata(filePath = '/repo/note.txt'): EditorRecoveryMetadata {
  return {
    hostId: 'local',
    worktreeId: 'wt',
    filePath,
    relativePath: 'note.txt',
    language: 'plaintext',
    bufferKind: 'edit'
  }
}
function put(content: string, owner = metadata()): EditorRecoveryChange {
  return {
    kind: 'put',
    id: 'buffer',
    expectedRevision: 0,
    state: 'active',
    metadata: owner,
    content
  }
}

describe('recovery writer process boundaries', () => {
  it('releases an idle worker and reopens the same committed journal without replaying imports', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const writer = client(fixture().path, workerPath, 15_000, 20)
    await writer.apply([put('committed before idle')])
    await expect.poll(() => terminate.mock.calls.length, { timeout: 2_000 }).toBe(1)
    expect(writer.isRunning).toBe(true)
    expect(await writer.read('buffer')).toMatchObject({
      content: 'committed before idle',
      revision: 1
    })
    await expect.poll(() => terminate.mock.calls.length, { timeout: 2_000 }).toBe(2)
    await writer.apply([{ ...put('new edit after idle'), expectedRevision: 1 }])
    expect(await writer.read('buffer')).toMatchObject({
      content: 'new edit after idle',
      revision: 2
    })
    await writer.close()
    await expect(writer.list()).rejects.toThrow('closed')
  })

  it('keeps an outstanding request alive beyond the idle deadline', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const f = fixture()
    const entry = join(f.root, 'slow-worker.cjs')
    writeFileSync(
      entry,
      `const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({ requestId, command }) => {
        if (command.kind === 'close') {
          parentPort.postMessage({ requestId, ok: true, result: undefined }); parentPort.close();
        } else setTimeout(() => parentPort.postMessage({ requestId, ok: true, result: [] }), 150);
      });`
    )
    const writer = client(f.path, entry, 2_000, 20)
    const reading = writer.list()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(terminate).not.toHaveBeenCalled()
    expect(await reading).toEqual([])
    await expect.poll(() => terminate.mock.calls.length, { timeout: 2_000 }).toBe(1)
  })

  it('survives an abrupt process kill after acknowledgement, with no graceful shutdown checkpoint', async () => {
    const f = fixture()
    const text = 'most recent unsaved text 😀\r\n'.repeat(30_000)
    const finalText = `${text}last incremental edit`
    const patch = createEditorRecoveryTextPatch(text, finalText)
    if (!patch) {
      throw new Error('Expected an incremental edit')
    }
    const input = join(f.root, 'draft.json')
    writeFileSync(
      input,
      JSON.stringify([
        put(text),
        {
          ...patch,
          kind: 'patch',
          id: 'buffer',
          expectedRevision: 1,
          metadata: metadata(),
          state: 'active'
        }
      ])
    )
    const script = `
      const { Worker } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const worker = new Worker(process.argv[1], { workerData: { databasePath: process.argv[2] } });
      worker.on('error', error => { console.error(error); process.exit(1); });
      worker.on('message', response => {
        if (!response.ok || response.result.at(-1)?.revision !== 2) process.exit(2);
        process.stdout.write('committed\\n');
      });
      worker.postMessage({ requestId: 1, command: { kind: 'apply', changes: JSON.parse(readFileSync(process.argv[3], 'utf8')) } });
      setInterval(() => {}, 1000);
    `
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', script, workerPath, f.path, input],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''
        const timer = setTimeout(() => finish(new Error(`Checkpoint timed out: ${stderr}`)), 10_000)
        const onData = (chunk: Buffer) => {
          stdout += chunk.toString()
          if (stdout.includes('committed\n')) {
            finish()
          }
        }
        const onExit = () => finish(new Error(`Writer exited before checkpoint: ${stderr}`))
        const finish = (error?: Error) => {
          clearTimeout(timer)
          child.stdout.off('data', onData)
          child.off('exit', onExit)
          child.off('error', finish)
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }
        child.stdout.on('data', onData)
        child.once('exit', onExit)
        child.once('error', finish)
      })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close')
        child.kill('SIGKILL')
        await exited
      }
    }
    const reopened = client(f.path)
    expect(await reopened.read('buffer')).toMatchObject({ content: finalText, revision: 2 })
  })

  it('exports an exact copy, keeps the source draft, and refuses stale revisions and the original file', async () => {
    const f = fixture()
    const original = join(f.root, 'note.txt')
    const recovered = join(f.root, 'note.recovered.txt')
    writeFileSync(original, 'disk baseline')
    const writer = client(f.path)
    await writer.apply([put('unsaved\r\n😀', metadata(original))])
    expect(await writer.export('buffer', 1, recovered)).toBe(recovered)
    expect(readFileSync(recovered, 'utf8')).toBe('unsaved\r\n😀')
    expect((await writer.read('buffer'))?.content).toBe('unsaved\r\n😀')
    await expect(writer.export('buffer', 1, original)).rejects.toThrow('separate file')
    await writer.apply([{ ...put('newer', metadata(original)), expectedRevision: 1 }])
    await expect(writer.export('buffer', 1, recovered)).rejects.toThrow('draft changed')
    expect(readFileSync(original, 'utf8')).toBe('disk baseline')
    expect(readFileSync(recovered, 'utf8')).toBe('unsaved\r\n😀')
  })

  it('migrates per profile, keeps source sessions intact, and does not replay retired versioned snapshots', async () => {
    const f = fixture()
    const legacy = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        wt: [{ ...metadata(), worktreeId: 'wt', dirtyDraftContent: 'legacy draft' }]
      }
    }
    const serialized = JSON.stringify(legacy)
    const service = new EditorRecoveryService(
      {
        getProfileStorageDirectory: () => f.root,
        getWorkspaceSessionHostIds: () => ['local'],
        getWorkspaceSession: () => legacy
      },
      (path) => client(path)
    )
    const restored = await service.restoreSession(legacy)
    const writer = await service.ready()
    const imported = (await writer.list())[0]
    if (!imported) {
      throw new Error('Legacy draft was not migrated')
    }
    expect(restored.openFilesByWorktree?.wt?.[0]).toMatchObject({
      dirtyDraftContent: 'legacy draft',
      recoveryId: imported.id,
      recoveryRevision: 1
    })
    expect(JSON.stringify(legacy)).toBe(serialized)
    const otherProfile = client(join(f.root, 'other-profile', 'editor-recovery.sqlite'))
    expect(await otherProfile.list()).toEqual([])
    await writer.apply([{ kind: 'resolve', id: imported.id, expectedRevision: 1 }])
    const clean = await service.restoreSession(restored)
    expect(clean.openFilesByWorktree?.wt?.[0]?.dirtyDraftContent).toBeUndefined()
    expect((await writer.status([imported.id]))[0]?.state).toBe('resolved')
    await writer.apply([
      { kind: 'resolve', id: 'saved-before-first-checkpoint', expectedRevision: 0 }
    ])
    const unacknowledged = {
      ...legacy,
      openFilesByWorktree: {
        wt: [
          {
            ...metadata(),
            dirtyDraftContent: 'already saved',
            recoveryId: 'saved-before-first-checkpoint'
          }
        ]
      }
    }
    expect(
      (await service.restoreSession(unacknowledged)).openFilesByWorktree?.wt?.[0]?.dirtyDraftContent
    ).toBeUndefined()
    await service.close()
    const restarted = new EditorRecoveryService(
      {
        getProfileStorageDirectory: () => f.root,
        getWorkspaceSessionHostIds: () => ['local'],
        getWorkspaceSession: () => restored
      },
      (path) => client(path)
    )
    expect(
      (await restarted.restoreSession(restored)).openFilesByWorktree?.wt?.[0]?.dirtyDraftContent
    ).toBeUndefined()
    expect(await (await restarted.ready()).list()).toEqual([])
  })

  it('rejects every pending caller when the worker exits, times out or sends an invalid acknowledgement', async () => {
    for (const [index, behavior] of [
      'process.exit(1)',
      'setInterval(() => {}, 1000)',
      'parentPort.postMessage({ requestId: request.requestId + 10, ok: true, result: [] })'
    ].entries()) {
      const f = fixture()
      const entry = join(f.root, `fault-${index}.cjs`)
      writeFileSync(
        entry,
        `const { parentPort } = require('node:worker_threads'); parentPort.on('message', request => { ${behavior} });`
      )
      const writer = client(f.path, entry, 100)
      const outcomes = await Promise.allSettled([writer.list(), writer.read('buffer')])
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
      expect(writer.isRunning).toBe(false)
      await expect(writer.apply([put('still unsaved')])).rejects.toThrow()
    }
  })

  it('migrates large legacy drafts in separate messages with exact text and stable identities', async () => {
    const f = fixture()
    const log = join(f.root, 'import-batches.jsonl')
    const entry = join(f.root, 'observed-worker.cjs')
    writeFileSync(
      entry,
      `const { parentPort } = require('node:worker_threads');
       const { appendFileSync } = require('node:fs');
       parentPort.on('message', ({ command }) => {
         if (command.kind === 'import') appendFileSync(${JSON.stringify(log)},
           JSON.stringify(command.drafts.map(draft => draft.content.length)) + '\\n');
       });
       require(${JSON.stringify(workerPath)});`
    )
    const drafts = [
      'a'.repeat(2 * 1024 * 1024),
      'b'.repeat(2 * 1024 * 1024),
      '\uD83D\uDE00'.repeat(1_500_000)
    ].map((content, index) => ({ metadata: metadata(`/repo/large-${index}.txt`), content }))
    const writer = client(f.path, entry)
    await writer.importLegacy(drafts)
    const imported = await writer.list()
    expect(imported).toHaveLength(3)
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual(drafts.map((draft) => [draft.content.length]))
    await writer.close()
    const reopened = client(f.path)
    await reopened.importLegacy(drafts)
    expect((await reopened.list()).map((draft) => draft.id).sort()).toEqual(
      imported.map((draft) => draft.id).sort()
    )
    for (const draft of drafts) {
      const recovered = imported.find((item) => item.filePath === draft.metadata.filePath)
      expect(recovered).toBeDefined()
      expect((await reopened.read(recovered?.id ?? 'missing'))?.content).toBe(draft.content)
    }
  })
})
