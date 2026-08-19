import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { materializeLifecycleExtension } from './extension-cache'
import {
  HANDSHAKE_STATUS_KEY,
  PI_RPC_WORKER_ACTIVE_TOOL_NAMES,
  buildLifecycleExtensionSource,
  type WorkspaceRuntimeDescriptor
} from './extension-source'

const runtime: WorkspaceRuntimeDescriptor = {
  sourceHash: 'b'.repeat(64),
  securitySource: 'file:///trusted-cache/workspace-security-runtime.ts',
  mutationSource: 'file:///trusted-cache/workspace-mutation-runtime.ts'
}

const FORBIDDEN_AUTHORITY_FIELDS = [
  'taskId',
  'dispatchId',
  'workerHandle',
  'capability',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_HOOK_TOKEN',
  'RuntimeClient'
]

const buildSource = (nonce = 'nonce-123'): string => buildLifecycleExtensionSource(nonce, runtime)

describe('generated Pi lifecycle extension', () => {
  it('uses only public extension APIs, TypeBox, and content-addressed runtime imports', () => {
    const source = buildSource()
    expect(source).toContain('import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"')
    expect(source).toContain('import { Type } from "typebox"')
    expect(source).toContain(runtime.securitySource)
    expect(source).toContain(runtime.mutationSource)
    expect(source).not.toMatch(/@earendil-works\/pi-coding-agent\/(?:src|dist)|require\(/u)
    expect(source).not.toMatch(/child_process|pi\.exec\(|name: "bash"/u)
  })

  it('registers only bounded workspace and lifecycle tools and attests every active source', () => {
    const source = buildSource()
    for (const name of PI_RPC_WORKER_ACTIVE_TOOL_NAMES) {
      expect(source).toContain(`name: "${name}"`)
    }
    expect(source).toContain('additionalProperties: false')
    expect(source).toContain('maximum: 256')
    expect(source).toContain('maxItems: 64')
    expect(source).toContain('if (doneClaimed) throw new Error')
    expect(source).toContain('ctx.shutdown()')
    expect(source).toContain('pi.getAllTools()')
    expect(source).toContain('pi.getActiveTools()')
    expect(source).toContain('pi.setActiveTools(ACTIVE_TOOL_NAMES)')
    expect(source).toContain('tool?.sourceInfo?.path')
    expect(source).toContain('return { name, source: SOURCE }')
    expect(source).toContain('attestActiveTools(pi, false)')
    expect(source).toContain('event.systemPrompt !== expectedPrompt')
    expect(source).toContain('JSON.stringify(options.selectedTools)')
    expect(source).toContain('JSON.stringify(options.toolSnippets)')
    expect(source).toContain('JSON.stringify(options.promptGuidelines)')
    expect(source).toContain('optionRoot !== workspaceRoot')
    expect(source).toContain('executionMode: "sequential"')
    expect(source).not.toContain('executionMode: "parallel"')
  })

  it('materializes deterministic content-addressed entry and runtime files in a private cache', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-pi-rpc-worker-test-'))
    const root = join(parent, 'cache')
    try {
      const first = await materializeLifecycleExtension('nonce-cache', root)
      const second = await materializeLifecycleExtension('nonce-cache', root)
      expect(first.path).toBe(second.path)
      expect(first.path).toContain(first.sourceHash)
      expect(first.selectedSource).toBe(pathToFileURL(first.path).href)
      expect(first.workspaceRuntime).toEqual(second.workspaceRuntime)
      for (const source of [
        first.workspaceRuntime.securitySource,
        first.workspaceRuntime.mutationSource
      ]) {
        const path = fileURLToPath(source)
        const info = await lstat(path)
        expect(info.isFile()).toBe(true)
        expect(info.isSymbolicLink()).toBe(false)
        expect(info.nlink).toBe(1)
        expect((await readFile(path, 'utf8')).length).toBeGreaterThan(100)
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('binds handshake to nonce, entry, runtime hash, and exact active tool manifest', () => {
    const source = buildSource('nonce-abc')
    expect(source).toContain(`setStatus(${JSON.stringify(HANDSHAKE_STATUS_KEY)}, JSON.stringify({`)
    expect(source).toContain('nonce-abc')
    expect(source).toContain('const SOURCE = import.meta.url')
    expect(source).toContain(`"sha256":"${runtime.sourceHash}"`)
    expect(source).toContain('tools')
    for (const field of FORBIDDEN_AUTHORITY_FIELDS) {
      expect(source).not.toContain(field)
    }
    expect(createHash('sha256').update(source).digest('hex')).toMatch(/^[a-f0-9]{64}$/u)
  })
})
