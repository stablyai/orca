import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { withSidecarSnapshotQueue } from '../sidecar-snapshot-file'
import { createNativeChatDraftStore } from './native-chat-draft-store'

const roots: string[] = []
let bundleDir = ''
let childEntry = ''

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-drafts-'))
  roots.push(root)
  return join(root, 'native-chat-drafts')
}

const draft = (text: string) => ({ text, attachments: [] })
const fileOf = (scopeKey: string) => `${createHash('sha256').update(scopeKey).digest('hex')}.json`

// A renderer that sends, then the app is killed: the clear it was told had landed must hold.
const CHILD_SOURCE = `
import { createNativeChatDraftStore } from './native-chat-draft-store'
const [root, mode] = process.argv.slice(2)
const store = createNativeChatDraftStore(root)
void (async () => {
  await store.write('session:s1', { text: 'hello', attachments: [] })
  if (mode === 'typing-in-flight') {
    void store.write('session:s1', { text: 'hello world', attachments: [] })
  }
  const result = await store.write('session:s1', null)
  if (mode === 'typing-in-flight') {
    await store.drain()
  }
  process.stdout.write(result, () => process.kill(process.pid, 'SIGKILL'))
})()
`

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'orca-native-chat-draft-child-'))
  childEntry = join(bundleDir, 'draft-child.cjs')
  await build({
    stdin: { contents: CHILD_SOURCE, resolveDir: __dirname, loader: 'ts' },
    outfile: childEntry,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
}, 30_000)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  if (bundleDir) {
    await rm(bundleDir, { recursive: true, force: true })
  }
})

describe('a clear confirmed before the app is killed', () => {
  it.each(['clear', 'typing-in-flight'])('stays cleared (%s)', async (mode) => {
    const root = await freshRoot()

    const child = await runProcess({
      program: process.execPath,
      args: [childEntry, root, mode],
      timeoutMs: 20_000
    })

    expect(child.stdout).toBe('persisted')
    expect(child.signal).toBe('SIGKILL')
    expect(await createNativeChatDraftStore(root).load()).toEqual([])
  })
})

describe('the native chat draft store', () => {
  it('loads what an earlier run saved, oldest first', async () => {
    const root = await freshRoot()
    const first = createNativeChatDraftStore(root)
    await first.write('pane:tab-1:leaf-1', draft('older'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await first.write('session:s1', {
      text: 'newer',
      attachments: [{ id: 'a1', path: '/tmp/a.png', location: 'local' }],
      tuiInputSeed: { agent: 'claude', text: 'seed', createdAt: 1 }
    })

    const next = createNativeChatDraftStore(root)

    expect(await next.load()).toEqual([
      { scopeKey: 'pane:tab-1:leaf-1', draft: draft('older') },
      {
        scopeKey: 'session:s1',
        draft: {
          text: 'newer',
          attachments: [{ id: 'a1', path: '/tmp/a.png', location: 'local' }],
          tuiInputSeed: { agent: 'claude', text: 'seed', createdAt: 1 }
        }
      }
    ])
    expect(next.loadSync()).toEqual(await next.load())
  })

  it('keeps the ids of outbox entries a draft took in, for a later reader', async () => {
    const root = await freshRoot()
    await createNativeChatDraftStore(root).write('session:s1', {
      ...draft('back'),
      importedOutboxEntryIds: ['m1']
    })

    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: { ...draft('back'), importedOutboxEntryIds: ['m1'] } }
    ])
  })

  it('keeps the sends a draft still holds for their host', async () => {
    const root = await freshRoot()
    const heldSends = [{ clientMessageId: 'm1', text: 'sent once', attachments: [], sentAt: 5 }]
    await createNativeChatDraftStore(root).write('session:s1', { ...draft(''), heldSends })

    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: { ...draft(''), heldSends } }
    ])
  })

  it('applies writes for one chat in the order they were asked for', async () => {
    const root = await freshRoot()
    const store = createNativeChatDraftStore(root)
    const writes = [
      store.write('session:s1', draft('h')),
      store.write('session:s1', draft('hello')),
      store.write('session:s1', null),
      store.write('session:s1', draft('next'))
    ]

    expect(await Promise.all(writes)).toEqual(['persisted', 'persisted', 'persisted', 'persisted'])
    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: draft('next') }
    ])
  })

  it('deletes the file for a cleared draft', async () => {
    const root = await freshRoot()
    const store = createNativeChatDraftStore(root)
    await store.write('session:s1', draft('hello'))
    await store.write('session:s1', draft(''))

    expect(await readdir(root)).toEqual([])
  })

  it('drops unreadable files and keeps a write made while loading', async () => {
    const root = await freshRoot()
    await createNativeChatDraftStore(root).write('session:s1', draft('old'))
    await writeFile(join(root, 'broken.json'), '{not json')

    const store = createNativeChatDraftStore(root)
    const written = store.write('session:s1', draft('new'))

    expect(await store.load()).toEqual([{ scopeKey: 'session:s1', draft: draft('new') }])
    await written
    expect((await readdir(root)).filter((name) => name === 'broken.json')).toEqual([])
  })

  it('sweeps temp files a killed run left mid-write', async () => {
    const root = await freshRoot()
    await createNativeChatDraftStore(root).write('session:s1', draft('hello'))
    const [saved] = await readdir(root)
    await writeFile(join(root, `${saved}.99999.1.ab.tmp`), '{"partial')

    await createNativeChatDraftStore(root).load()

    expect(await readdir(root)).toEqual([saved])
  })

  // A downgrade, or a file that can't be read right now, must not cost the user a draft.
  it("keeps a newer build's drafts and files it could not read", async () => {
    const root = await freshRoot()
    const store = createNativeChatDraftStore(root)
    await store.write('session:s1', draft('mine'))
    const newer = { v: 2, scopeKey: 'session:s2', savedAt: 1, text: 'from a newer build' }
    await writeFile(join(root, fileOf('session:s2')), JSON.stringify(newer))
    // A directory where a file should be: reading it fails with something other than ENOENT.
    await mkdir(join(root, fileOf('session:s3')))
    await writeFile(join(root, fileOf('session:s4')), JSON.stringify({ v: 1, scopeKey: 7 }))

    expect(await createNativeChatDraftStore(root).load()).toEqual([
      { scopeKey: 'session:s1', draft: draft('mine') }
    ])
    expect((await readdir(root)).sort()).toEqual(
      [fileOf('session:s1'), fileOf('session:s2'), fileOf('session:s3')].sort()
    )
  })

  it('removes JSON files that carry no newer version', async () => {
    const root = await freshRoot()
    await createNativeChatDraftStore(root).write('session:s1', draft('mine'))
    for (const [key, body] of [
      ['session:empty', '{}'],
      ['session:array', '[]'],
      ['session:string', '"x"'],
      ['session:older', JSON.stringify({ v: 0, scopeKey: 'session:older', text: 'old' })]
    ]) {
      await writeFile(join(root, fileOf(key)), body)
    }

    await createNativeChatDraftStore(root).load()

    expect(await readdir(root)).toEqual([fileOf('session:s1')])
  })

  // Deletions at load share the chat's queue, so a write made meanwhile always survives them.
  it('never deletes, at load, a draft written while loading', async () => {
    const root = await freshRoot()
    const seed = createNativeChatDraftStore(root)
    for (let index = 0; index < 130; index += 1) {
      await seed.write(`session:${index}`, draft(`draft-${index}`))
      if (index < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    await writeFile(join(root, fileOf('session:garbage')), '{not json')

    // Hold both chats' queues so load reads the old files, then the writes land, then load decides.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    void withSidecarSnapshotQueue(join(root, fileOf('session:0')), () => held)
    void withSidecarSnapshotQueue(join(root, fileOf('session:garbage')), () => held)
    const store = createNativeChatDraftStore(root)
    const oldest = store.write('session:0', draft('typed after relaunch'))
    const overGarbage = store.write('session:garbage', draft('typed over garbage'))
    const loaded = store.load()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await loaded

    expect(await oldest).toBe('persisted')
    expect(await overGarbage).toBe('persisted')
    const next = new Map(
      (await createNativeChatDraftStore(root).load()).map(({ scopeKey, draft }) => [
        scopeKey,
        draft
      ])
    )
    expect(next.get('session:0')).toEqual(draft('typed after relaunch'))
    expect(next.get('session:garbage')).toEqual(draft('typed over garbage'))
  })

  it('keeps only the newest drafts past the bound', async () => {
    const root = await freshRoot()
    const store = createNativeChatDraftStore(root)
    for (let index = 0; index < 130; index += 1) {
      await store.write(`session:${index}`, draft(`draft-${index}`))
      if (index < 2) {
        // The two oldest are written in earlier milliseconds than the rest.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }

    const loaded = await createNativeChatDraftStore(root).load()

    expect(loaded).toHaveLength(128)
    expect(loaded.map(({ scopeKey }) => scopeKey)).not.toContain('session:0')
    expect(loaded.map(({ scopeKey }) => scopeKey)).not.toContain('session:1')
    expect((await readdir(root)).filter((name) => name.endsWith('.json'))).toHaveLength(128)
  })

  it('reports a failed write without throwing', async () => {
    const root = await freshRoot()
    await writeFile(join(root, '..', 'blocker'), '')
    const store = createNativeChatDraftStore(join(root, '..', 'blocker', 'drafts'))

    await expect(store.write('session:s1', draft('hello'))).resolves.toBe('failed')
  })
})
