// Live adapter probe: spawns the REAL guest clangd (version 18 on this host's
// Ubuntu-24.04 distro) through the WSL host adapter and drives a minimal LSP
// handshake (initialize -> didOpen -> hover -> definition -> references) over
// the process stdio. This is the fast feedback loop for ticket 16's live
// acceptance — it shakes out host-adapter seams (guest-env probe, clangd
// PATH discovery, wsl.exe --exec spawn, UNC<->guest path mapping, LSP framing)
// against a real second host without a Playwright app launch.
//
// Self-skips when no WSL distro + clangd is reachable, so it stays benign in
// CI on hosts without WSL. Run explicitly:
//   pnpm test src/main/language-servers/wsl-live-clangd-probe.test.ts
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  selectHostAdapter,
  resetHostAdapterCacheForTests,
  type LanguageServerHostAdapter
} from './language-server-host-adapter'
import { resolveWslClangdPath, resolveWslClangdVersionGate } from './wsl-clangd-resolution'
import { getWslGuestEnvironment } from '../wsl/wsl-guest-environment'

const GUEST_DIR = 'orca-wsl-lsp-probe'
const DISTRO = process.env.ORCA_WSL_LSP_PROBE_DISTRO ?? 'Ubuntu-24.04'

function runWsl(args: string[]): string {
  return execFileSync('wsl.exe', ['-d', DISTRO, '--exec', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
}

function guestHome(): string {
  return runWsl(['sh', '-c', 'printf %s "$HOME"']).trim()
}

function ensureGuestProject(home: string): {
  linuxRoot: string
  uncRoot: string
  uncMain: string
} {
  const linuxRoot = `${home}/${GUEST_DIR}`
  const script = [
    'set -e',
    'cd ~',
    `rm -rf "${GUEST_DIR}"`,
    `mkdir -p "${GUEST_DIR}"`,
    `cd "${GUEST_DIR}"`,
    `cat > foo.h <<'EOF'`,
    '#ifndef FOO_H',
    '#define FOO_H',
    'const char* foo(int value);',
    '#endif',
    'EOF',
    `cat > main.cpp <<'EOF'`,
    '#include "foo.h"',
    'int main() {',
    '    int x = 42;',
    '    const char* result = foo(x);',
    '    return 0;',
    '}',
    'EOF'
  ].join('\n')
  runWsl(['sh', '-c', script])
  // Why build the UNC from the guest POSIX home: the host adapter's
  // parseWslUncPath recovers exactly this linuxPath, so the round trip is exact.
  const uncRoot = `\\\\wsl.localhost\\${DISTRO}${home.replace(/\//g, '\\')}\\${GUEST_DIR}`
  return {
    linuxRoot,
    uncRoot,
    uncMain: `${uncRoot}\\main.cpp`
  }
}

// Minimal LSP JSON-RPC client over Content-Length framing. clangd speaks
// LSP over stdio; we only need initialize/didOpen/hover/definition/references
// to prove the seam — no full client. Drains on every stdout chunk so async
// responses are resolved as soon as they arrive, not on the next request.
function createLspClient(): {
  onStdoutChunk: (chunk: Buffer) => void
  waitForResponse: (id: number, timeoutMs?: number) => Promise<unknown>
} {
  let buffer = Buffer.alloc(0)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  function processBuffer(): void {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header)
      if (!lengthMatch) {
        return
      }
      const length = Number(lengthMatch[1])
      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + length) {
        return
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      try {
        const msg = JSON.parse(body)
        if (msg.id !== undefined && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) {
            entry.reject(new Error(JSON.stringify(msg.error)))
          } else {
            entry.resolve(msg.result)
          }
        }
      } catch {
        // partial/non-JSON — wait for more
      }
    }
  }

  return {
    onStdoutChunk(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk])
      processBuffer()
    },
    waitForResponse(id: number, timeoutMs = 10_000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`LSP request ${id} timed out after ${timeoutMs}ms`))
          }
        }, timeoutMs)
      })
    }
  }
}

function encodeLsp(id: number, method: string, params: unknown): Buffer {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function encodeNotification(method: string, params: unknown): Buffer {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params })
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

const hasWsl = (() => {
  if (process.platform !== 'win32') {
    return false
  }
  try {
    const out = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    })
    return out.replaceAll('\u0000', '').toLowerCase().includes(DISTRO.toLowerCase())
  } catch {
    return false
  }
})()

describe.skipIf(!hasWsl)('WSL host adapter — live guest clangd probe (ticket 16)', () => {
  let adapter: LanguageServerHostAdapter
  let project: { linuxRoot: string; uncRoot: string; uncMain: string }
  let clangdPath: string | null
  let gate: { kind: string; major: number | null }

  beforeAll(async () => {
    resetHostAdapterCacheForTests()
    const home = guestHome()
    project = ensureGuestProject(home)
    adapter = selectHostAdapter(project.uncRoot)
    const env = await getWslGuestEnvironment(DISTRO, 8_000)
    clangdPath = await resolveWslClangdPath(DISTRO, env)
    gate = await resolveWslClangdVersionGate(DISTRO, env, clangdPath ?? 'clangd')
  })

  it('selects the WSL adapter for a UNC worktree root', () => {
    expect(adapter.kind).toBe('wsl')
  })

  it('discovers clangd on the guest PATH', () => {
    expect(clangdPath, 'clangd not found in guest PATH').toMatch(/clangd$/)
  })

  it('classifies the guest clangd version as ok or suggest-upgrade (not reject)', () => {
    expect(['ok', 'suggest-upgrade']).toContain(gate.kind)
    expect(gate.major, 'version major should be parsed').not.toBeNull()
  })

  it('round-trips UNC -> guest URI -> UNC path mapping (box 3, pure)', () => {
    const uri = adapter.pathToLspUri(project.uncMain)
    expect(uri.startsWith('file:///home/')).toBe(true)
    expect(uri.endsWith('/main.cpp')).toBe(true)
    const back = adapter.lspUriToPath(uri)
    expect(back.toLowerCase().replace(/\//g, '\\')).toBe(
      project.uncMain.toLowerCase().replace(/\//g, '\\')
    )
  })

  it('spawns guest clangd + completes initialize/didOpen/hover/definition against the real binary', async () => {
    const { openNativeLanguageServerProcess } = await import('./native-language-server-process')
    const launch = await adapter.buildLaunch(project.uncRoot)
    expect(launch.program).toMatch(/wsl\.exe$/i)

    const stderrLines: string[] = []
    const handle = openNativeLanguageServerProcess(
      { program: launch.program, args: launch.args, cwd: launch.cwd, env: launch.env },
      {
        onStdoutChunk: (chunk) => lsp.onStdoutChunk(chunk),
        onStderrLine: (line) => stderrLines.push(line),
        onExit: () => {}
      }
    )
    const lsp = createLspClient()
    try {
      // initialize
      handle.write(
        encodeLsp(1, 'initialize', {
          processId: process.pid,
          rootUri: adapter.pathToLspUri(project.uncRoot),
          capabilities: {},
          workspaceFolders: [{ uri: adapter.pathToLspUri(project.uncRoot), name: 'probe' }]
        })
      )
      const init = (await lsp.waitForResponse(1, 15_000)) as {
        capabilities?: unknown
      } | null
      expect(
        init,
        `initialize result: ${JSON.stringify(init)}\nstderr: ${stderrLines.join('\n')}`
      ).not.toBeNull()
      handle.write(encodeNotification('initialized', {}))

      // didOpen the guest main.cpp with the guest-form URI clangd expects.
      const docUri = adapter.pathToLspUri(project.uncMain)
      handle.write(
        encodeNotification('textDocument/didOpen', {
          textDocument: {
            uri: docUri,
            languageId: 'cpp',
            version: 1,
            text: '#include "foo.h"\nint main() {\n    int x = 42;\n    const char* result = foo(x);\n    return 0;\n}\n'
          }
        })
      )

      // hover on foo (0-based line 3, char 25): the text has no leading
      // blank line, so the foo() call lands on line 3, not line 4.
      handle.write(
        encodeLsp(2, 'textDocument/hover', {
          textDocument: { uri: docUri },
          position: { line: 3, character: 25 }
        })
      )
      const hover = (await lsp.waitForResponse(2, 30_000)) as {
        contents?: unknown
      } | null
      expect(
        hover,
        `hover result: ${JSON.stringify(hover)}\nstderr: ${stderrLines.join('\n')}`
      ).not.toBeNull()
      const hoverStr = JSON.stringify(hover).toLowerCase()
      expect(hoverStr).toContain('foo')

      // definition -> clangd returns a guest location; assert it names foo.h.
      handle.write(
        encodeLsp(3, 'textDocument/definition', {
          textDocument: { uri: docUri },
          position: { line: 3, character: 25 }
        })
      )
      const def = (await lsp.waitForResponse(3, 30_000)) as { uri?: string }[] | null
      expect(def, `definition result: ${JSON.stringify(def)}`).not.toBeNull()
      const defUri = Array.isArray(def) ? def[0]?.uri : undefined
      expect(defUri, `definition uri: ${defUri}`).toMatch(/foo\.h$/)
      // The guest URI reverse-maps to the UNC form Orca opens (box 3).
      const reversed = adapter.lspUriToPath(defUri!)
      expect(reversed.toLowerCase()).toContain('wsl.localhost')
      expect(reversed).toMatch(/foo\.h$/i)
    } finally {
      handle.endStdin()
      await handle.killTree()
    }
  }, 90_000)
})
