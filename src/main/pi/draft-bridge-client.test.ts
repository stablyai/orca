import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preparePiDraftBridge } from './draft-bridge-directory'
import {
  readPiDraftBridgeCapability,
  requestPiDraftCapture,
  requestPiDraftReplace
} from './draft-bridge-client'

const roots: string[] = []

function bridgeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-draft-bridge-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type FakeEditor = { text: string }

function startFakeEditor(dir: string, token: string, editor: FakeEditor): () => void {
  let lastId = ''
  const timer = setInterval(() => {
    try {
      const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))
      if (request.token !== token || typeof request.id !== 'string' || request.id === lastId) {
        return
      }
      lastId = request.id
      const sourceToken = `token:${editor.text}`
      let response: Record<string, unknown>
      if (request.op === 'capture') {
        response = { ok: true, text: editor.text, sourceToken }
      } else if (request.baseToken !== sourceToken) {
        response = { ok: false, error: 'conflict', text: editor.text, sourceToken }
      } else {
        editor.text = request.text
        response = { ok: true, text: editor.text, sourceToken: `token:${editor.text}` }
      }
      writeFileSync(
        join(dir, 'response.json'),
        JSON.stringify({ protocol: 1, token, id: request.id, ...response })
      )
    } catch {}
  }, 5)
  return () => clearInterval(timer)
}

function writeHello(dir: string, token: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'hello.json'),
    JSON.stringify({
      protocol: 1,
      token,
      instanceId: 'instance',
      pid: process.pid,
      startedAt: 1,
      at: Date.now(),
      capabilities: { capture: true, replace: true },
      ...overrides
    })
  )
}

describe('Pi draft bridge client', () => {
  it('reads the exact editor text and replaces only the captured version', async () => {
    const root = bridgeDir()
    const paths = preparePiDraftBridge(root, 'pty-1', 'tab:leaf')
    writeHello(paths.dir, paths.session.token)
    const editor = { text: 'first\nsecond\nthird' }
    const stop = startFakeEditor(paths.dir, paths.session.token, editor)
    try {
      expect(await readPiDraftBridgeCapability(paths)).toMatchObject({ supported: true })
      const captured = await requestPiDraftCapture(paths, 3000)
      expect(captured).toMatchObject({ ok: true, text: 'first\nsecond\nthird' })
      const replaced = await requestPiDraftReplace(
        paths,
        'first\nsecond EDITED\nthird',
        captured!.sourceToken!,
        3000
      )
      expect(replaced).toMatchObject({ ok: true, text: 'first\nsecond EDITED\nthird' })
      expect(editor.text).toBe('first\nsecond EDITED\nthird')

      // A remote keystroke after capture invalidates the token rather than being overwritten.
      editor.text += 'X'
      const conflict = await requestPiDraftReplace(paths, 'blind overwrite', replaced!.sourceToken!)
      expect(conflict).toMatchObject({
        ok: false,
        error: 'conflict',
        text: 'first\nsecond EDITED\nthirdX'
      })
    } finally {
      stop()
    }
  })

  it('refuses a hello from another process instance', async () => {
    const root = bridgeDir()
    const paths = preparePiDraftBridge(root, 'pty-1', 'tab:leaf')
    writeHello(paths.dir, 'different-token')
    expect(await readPiDraftBridgeCapability(paths)).toEqual({
      supported: false,
      reason: 'no_bridge'
    })
  })

  it('treats a stale heartbeat or dead process as unsupported', async () => {
    const root = bridgeDir()
    const paths = preparePiDraftBridge(root, 'pty-1', 'tab:leaf')
    writeHello(paths.dir, paths.session.token, { at: Date.now() - 60_000 })
    expect(await readPiDraftBridgeCapability(paths)).toEqual({
      supported: false,
      reason: 'stale_bridge'
    })
  })

  it('reports a timeout instead of inventing success', async () => {
    const root = bridgeDir()
    const paths = preparePiDraftBridge(root, 'pty-1', 'tab:leaf')
    writeHello(paths.dir, paths.session.token)
    expect(await requestPiDraftCapture(paths, 80)).toBeNull()
  })
})
