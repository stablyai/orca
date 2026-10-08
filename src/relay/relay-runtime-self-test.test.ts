import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeRelayRuntime } from './relay-runtime-identity'
import { runRelayRuntimeSelfTest } from './relay-runtime-self-test'
import { relayConptyDllSpawnOptions } from './relay-windows-conpty'

const nodePtyDir = dirname(require.resolve('node-pty/package.json'))
const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('relay runtime identity', () => {
  it('names the pinned store layout pinned-node and anything else host-node', () => {
    const sha = 'a'.repeat(64)
    expect(describeRelayRuntime(`/h/.orca-remote/runtimes/node-${sha}/bin/node`).kind).toBe(
      'pinned-node'
    )
    expect(describeRelayRuntime('/usr/bin/node').kind).toBe('host-node')
    expect(describeRelayRuntime(`/tmp/node-${sha}/bin/node`).kind).toBe('host-node')
    expect(describeRelayRuntime('/usr/bin/node').version).toBe(process.versions.node)
  })

  it('recognizes node.exe at the Windows store root', () => {
    const sha = 'b'.repeat(64)
    const win = (execPath: string): string => describeRelayRuntime(execPath, path.win32).kind
    expect(win(`C:\\Users\\u\\.orca-remote\\runtimes\\node-${sha}\\node.exe`)).toBe('pinned-node')
    expect(win(`C:/Users/u/.orca-remote/runtimes/node-${sha}/NODE.EXE`)).toBe('pinned-node')
    expect(win('C:\\Program Files\\nodejs\\node.exe')).toBe('host-node')
    expect(win(`C:\\Users\\u\\runtimes\\node-${sha}\\bun.exe`)).toBe('host-node')
  })
})

function fakeWindowsNodePty(withConpty: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-win-pty-'))
  directories.push(dir)
  const release = join(dir, 'build', 'Release')
  mkdirSync(join(release, 'conpty'), { recursive: true })
  writeFileSync(join(release, 'conpty.node'), 'not a real addon')
  if (withConpty) {
    writeFileSync(join(release, 'conpty', 'conpty.dll'), 'dll')
    writeFileSync(join(release, 'conpty', 'OpenConsole.exe'), 'exe')
  }
  return dir
}

describe('Windows bundled ConPTY', () => {
  it('opts only a pinned-Node relay on win32 into the bundled DLL', () => {
    const dir = fakeWindowsNodePty(true)
    expect(relayConptyDllSpawnOptions(dir, 'pinned-node', 'win32')).toEqual({ useConptyDll: true })
    expect(relayConptyDllSpawnOptions(dir, 'host-node', 'win32')).toEqual({})
    expect(relayConptyDllSpawnOptions(dir, 'pinned-node', 'linux')).toEqual({})
    expect(relayConptyDllSpawnOptions(fakeWindowsNodePty(false), 'pinned-node', 'win32')).toEqual(
      {}
    )
  })

  it('reports a quarantined ConPTY pair as a load failure before touching the addon', async () => {
    const report = await runRelayRuntimeSelfTest('n', fakeWindowsNodePty(false), 'win32')
    expect(report).toMatchObject({ ok: false, stage: 'load' })
    expect(report.ok === false && report.error).toMatch(/bundled ConPTY file missing after upload/)
  })

  it('looks for conpty.node, not pty.node, on win32', async () => {
    const report = await runRelayRuntimeSelfTest('n', fakeWindowsNodePty(true), 'win32')
    // The fake addon cannot load here; reaching dlopen proves the Windows binding was chosen.
    expect(report).toMatchObject({ ok: false, stage: 'load' })
    expect(report.ok === false && report.error).not.toMatch(/no PTY binding/)
  })
})

describe.skipIf(process.platform === 'win32')('relay runtime self-test', () => {
  it('loads pty.node and opens and closes a PTY, echoing the nonce', async () => {
    const report = await runRelayRuntimeSelfTest('nonce-1', nodePtyDir)
    expect(report).toMatchObject({ nonce: 'nonce-1', ok: true, node: process.version })
  })

  it('reports a load-stage failure when the binding is absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'relay-selftest-'))
    directories.push(empty)
    const report = await runRelayRuntimeSelfTest('n', empty)
    expect(report).toMatchObject({ ok: false, stage: 'load' })
  })
})
