import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript-api'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_PI_DRAFT_BRIDGE_DIR_ENV,
  ORCA_PI_DRAFT_BRIDGE_TOKEN_ENV,
  getPiDraftBridgeExtensionSource
} from './draft-bridge-extension-source'

type Handler = (event?: unknown, context?: unknown) => Promise<void> | void

const roots: string[] = []

afterEach(() => {
  delete process.env[ORCA_PI_DRAFT_BRIDGE_DIR_ENV]
  delete process.env[ORCA_PI_DRAFT_BRIDGE_TOKEN_ENV]
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createExtensionHarness(normalize: (text: string) => string = (text) => text) {
  const inputHandlers: ((data: string) => undefined)[] = []
  const dir = mkdtempSync(join(tmpdir(), 'orca-draft-extension-'))
  roots.push(dir)
  const token = 'bridge-token'
  process.env[ORCA_PI_DRAFT_BRIDGE_DIR_ENV] = dir
  process.env[ORCA_PI_DRAFT_BRIDGE_TOKEN_ENV] = token
  const handlers: Record<string, Handler> = {}
  const pi = {
    on(name: string, handler: Handler) {
      handlers[name] = handler
    }
  }
  const output = ts.transpileModule(getPiDraftBridgeExtensionSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const module: { exports: { default?: (pi: unknown) => void } } = { exports: {} }
  const context = createContext({
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    process,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  })
  runInContext(output, context)
  module.exports.default?.(pi)

  const editor = { text: '' }
  const contextObject = {
    mode: 'tui',
    hasUI: true,
    ui: {
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        editor.text = normalize(text)
      },
      onTerminalInput: (handler: (data: string) => undefined) => {
        inputHandlers.push(handler)
        return () => {
          const index = inputHandlers.indexOf(handler)
          if (index !== -1) {
            inputHandlers.splice(index, 1)
          }
        }
      }
    },
    sessionManager: { getSessionId: () => 'session-1' }
  }

  return {
    dir,
    token,
    handlers,
    editor,
    contextObject,
    inputHandlers
  }
}

function sendRequest(dir: string, token: string, request: Record<string, unknown>): { id: string } {
  const id = `req-${Math.random().toString(36).slice(2)}`
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ protocol: 1, token, id, ...request }))
  return { id }
}

async function waitResponse(dir: string, id: string): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8'))
      if (response.id === id) {
        return response
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return null
}

describe('Pi draft bridge extension', () => {
  it('publishes capability and round-trips the real editor text', async () => {
    const harness = createExtensionHarness()
    await harness.handlers.session_start?.({}, harness.contextObject)
    const hello = JSON.parse(readFileSync(join(harness.dir, 'hello.json'), 'utf8'))
    expect(hello).toMatchObject({
      protocol: 1,
      token: harness.token,
      capabilities: { capture: true, replace: true }
    })

    harness.editor.text = 'line one\nline two\nline three'
    const capture = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const captured = await waitResponse(harness.dir, capture.id)
    expect(captured).toMatchObject({
      ok: true,
      text: 'line one\nline two\nline three'
    })

    const replace = sendRequest(harness.dir, harness.token, {
      op: 'replace',
      text: 'line one\nline two EDITED\nline three',
      baseToken: captured!.sourceToken
    })
    const replaced = await waitResponse(harness.dir, replace.id)
    expect(replaced).toMatchObject({ ok: true, text: 'line one\nline two EDITED\nline three' })
    expect(harness.editor.text).toBe('line one\nline two EDITED\nline three')

    harness.editor.text += '!'
    const conflict = sendRequest(harness.dir, harness.token, {
      op: 'replace',
      text: 'blind overwrite',
      baseToken: replaced!.sourceToken
    })
    expect(await waitResponse(harness.dir, conflict.id)).toMatchObject({
      ok: false,
      error: 'conflict',
      text: 'line one\nline two EDITED\nline three!'
    })
    await harness.handlers.session_shutdown?.()
  })

  it('reports Pi normalization instead of claiming the exact text was written', async () => {
    const harness = createExtensionHarness((text) => text.replaceAll('\t', '    '))
    await harness.handlers.session_start?.({}, harness.contextObject)
    harness.editor.text = 'a\tb'
    const capture = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const captured = await waitResponse(harness.dir, capture.id)
    const replace = sendRequest(harness.dir, harness.token, {
      op: 'replace',
      text: 'line\twith tab',
      baseToken: captured!.sourceToken
    })
    expect(await waitResponse(harness.dir, replace.id)).toMatchObject({
      ok: true,
      text: 'line    with tab',
      normalized: true
    })
    expect(harness.editor.text).toBe('line    with tab')

    harness.editor.text = 'already spaced'
    const second = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const secondCapture = await waitResponse(harness.dir, second.id)
    const normalizeToExisting = sendRequest(harness.dir, harness.token, {
      op: 'replace',
      text: 'already\tspaced',
      baseToken: secondCapture!.sourceToken
    })
    expect(await waitResponse(harness.dir, normalizeToExisting.id)).toMatchObject({
      ok: true,
      text: 'already    spaced',
      normalized: true
    })
    await harness.handlers.session_shutdown?.()
  })

  it('fences an undo back to earlier text with a new revision token', async () => {
    const harness = createExtensionHarness()
    await harness.handlers.session_start?.({}, harness.contextObject)
    harness.editor.text = 'original'
    const first = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const firstToken = (await waitResponse(harness.dir, first.id))!.sourceToken
    harness.editor.text = 'changed'
    await new Promise((resolve) => setTimeout(resolve, 80))
    harness.editor.text = 'original'
    await new Promise((resolve) => setTimeout(resolve, 80))
    const second = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const secondToken = (await waitResponse(harness.dir, second.id))!.sourceToken
    expect(secondToken).not.toBe(firstToken)
    await harness.handlers.session_shutdown?.()
  })

  it('invalidates a token on terminal input, including a change undone before the poll', async () => {
    const harness = createExtensionHarness()
    await harness.handlers.session_start?.({}, harness.contextObject)
    harness.editor.text = 'original'
    const first = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const firstToken = (await waitResponse(harness.dir, first.id))!.sourceToken
    harness.inputHandlers[0]?.('x')
    const second = sendRequest(harness.dir, harness.token, { op: 'capture' })
    const secondToken = (await waitResponse(harness.dir, second.id))!.sourceToken
    expect(secondToken).not.toBe(firstToken)
    await harness.handlers.session_shutdown?.()
  })

  it('ignores requests carrying a different process token', async () => {
    const harness = createExtensionHarness()
    await harness.handlers.session_start?.({}, harness.contextObject)
    sendRequest(harness.dir, 'other-process', { op: 'capture' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(() => readFileSync(join(harness.dir, 'response.json'), 'utf8')).toThrow()
    await harness.handlers.session_shutdown?.()
  })

  it('does not advertise or serve a bridge outside the TUI', async () => {
    const harness = createExtensionHarness()
    await harness.handlers.session_start?.({}, { ...harness.contextObject, mode: 'rpc' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(() => readFileSync(join(harness.dir, 'hello.json'), 'utf8')).toThrow()
    await harness.handlers.session_shutdown?.()
  })
})
