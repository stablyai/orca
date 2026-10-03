// The send ordering against a real kill: the composer's draft cache, saving through this main
// store, in a child process that SIGKILLs itself while a message is out. A kill before the host has
// the message must leave it saved (restored unsent); one after the save that follows must not.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { createNativeChatDraftStore } from './native-chat-draft-store'

const CACHE = resolve(
  __dirname,
  '../../renderer/src/components/native-chat/native-chat-draft-cache'
)

const CHILD_SOURCE = `
import { createNativeChatDraftStore } from './native-chat-draft-store'
import {
  clearNativeChatDraftForSend,
  writeNativeChatDraftCache
} from ${JSON.stringify(CACHE)}
const [root, mode] = process.argv.slice(2)
const store = createNativeChatDraftStore(root)
// The desktop bridge, minus the IPC hop.
Object.assign(globalThis, { window: { api: { nativeChat: { drafts: store } } } })
const KEY = 'session:s1'
void (async () => {
  writeNativeChatDraftCache(KEY, 'sent text', 'now')
  await store.drain()
  // Enter: the box empties and the message goes out; the host has not taken it yet.
  const save = clearNativeChatDraftForSend(KEY, () => writeNativeChatDraftCache(KEY, '', 'now'))
  if (mode === 'host-took-it') {
    save()
  }
  // Every write asked of the store so far has landed before the kill.
  await store.drain()
  process.stdout.write('killing', () => process.kill(process.pid, 'SIGKILL'))
})()
`

const roots: string[] = []
let bundleDir = ''
let childEntry = ''

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'orca-native-chat-draft-send-kill-'))
  childEntry = join(bundleDir, 'send-kill-child.cjs')
  await build({
    stdin: { contents: CHILD_SOURCE, resolveDir: __dirname, loader: 'ts' },
    outfile: childEntry,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron', '@tiptap/react'],
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

async function killedDuringSend(mode: 'before-host' | 'host-took-it') {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-native-chat-drafts-'))
  roots.push(tempRoot)
  const root = join(tempRoot, 'native-chat-drafts')
  const child = await runProcess({
    program: process.execPath,
    args: [childEntry, root, mode],
    timeoutMs: 20_000
  })
  expect(child.stdout).toBe('killing')
  expect(child.signal).toBe('SIGKILL')
  return createNativeChatDraftStore(root).load()
}

describe('a send killed partway', () => {
  it('restores the message when the host did not have it yet', async () => {
    expect(await killedDuringSend('before-host')).toEqual([
      { scopeKey: 'session:s1', draft: { text: 'sent text', attachments: [] } }
    ])
  })

  it('does not bring the message back once the host had it and the box was saved', async () => {
    expect(await killedDuringSend('host-took-it')).toEqual([])
  })
})
