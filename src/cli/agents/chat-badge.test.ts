import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { CHAT_HANDLERS } from './chat'

let dir = ''
let calls: { method: string; params: unknown }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-chat-badge-'))
  calls = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function run(flags: Record<string, string | boolean>): Promise<void> {
  return CHAT_HANDLERS['chat badge']({
    flags: new Map(Object.entries(flags)),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only reads isRemote and calls one method.
    client: {
      isRemote: true,
      call: async (method: string, params: { badge: unknown }) => {
        calls.push({ method, params })
        return { id: '1', ok: true, result: { badge: params.badge } }
      }
    } as unknown as HandlerContext['client'],
    cwd: dir,
    json: true
  })
}

it('sends the picture inline, read from the folder the command runs in', async () => {
  writeFileSync(join(dir, 'blender.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await run({ session: 'chat-1', icon: 'blender.png', label: 'Linked to Blender' })
  expect(calls).toEqual([
    {
      method: 'agentSession.setBadge',
      params: {
        sessionId: 'chat-1',
        badge: {
          label: 'Linked to Blender',
          icon: 'data:image/png;base64,iVBORw=='
        }
      }
    }
  ])
})

it('clears with --clear', async () => {
  await run({ session: 'chat-1', clear: true })
  expect(calls).toEqual([
    {
      method: 'agentSession.setBadge',
      params: { sessionId: 'chat-1', badge: null }
    }
  ])
})

it.each([
  ['a picture over the limit', 'big.png', 7000, 'Blender', '--icon is 7000 bytes'],
  ['an empty picture', 'empty.png', 0, 'Blender', 'is empty'],
  ['a file that is not a picture', 'notes.txt', 10, 'Blender', '--icon must be a .png, .webp'],
  ['a repeated --label', 'a.png', 10, 'Blender\0Linked', 'Pass --label once'],
  ['a label with no visible text', 'a.png', 10, '\u200B\u0007', '--label must have visible text']
])('refuses %s before calling the host', async (_case, name, size, label, message) => {
  writeFileSync(join(dir, name), Buffer.alloc(size))
  await expect(run({ session: 'chat-1', icon: name, label })).rejects.toThrow(message)
  expect(calls).toEqual([])
})

it('refuses --clear together with a picture', async () => {
  await expect(run({ session: 'chat-1', clear: true, icon: 'a.png' })).rejects.toThrow(
    'Pass either --clear or --icon with --label.'
  )
  expect(calls).toEqual([])
})
