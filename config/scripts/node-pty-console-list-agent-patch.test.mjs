import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PATCH_OUTCOME,
  assertPatchedNodePtyConsoleListAgent,
  classifyNodePtyConsoleListAgent,
  patchNodePtyConsoleListAgent
} = require('../relay-assets/node-pty-1.1.0-console-list-agent-patch.cjs')
const projectDir = resolve(import.meta.dirname, '..', '..')
const cleanupDirs = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Windows SSH relay node-pty console-list patch', () => {
  it('installs and verifies the fallback idempotently (known original -> patched)', () => {
    const fixture = writeNodePtyFixture('1.1.0', publishedAgentSource())

    expect(classifyNodePtyConsoleListAgent(fixture.root).outcome).toBe(
      PATCH_OUTCOME.UNPATCHED_ORIGINAL
    )

    const firstResult = patchNodePtyConsoleListAgent(fixture.root)
    expect(firstResult.outcome).toBe(PATCH_OUTCOME.PATCHED)
    const once = readFileSync(fixture.agentPath, 'utf8')
    expect(once).toContain('consoleProcessList = [shellPid];')
    expect(existsSync(`${fixture.agentPath}.orca-patch-${process.pid}`)).toBe(false)
    expect(() => assertPatchedNodePtyConsoleListAgent(fixture.root)).not.toThrow()

    // Already patched -> no-op, source byte-identical.
    const secondResult = patchNodePtyConsoleListAgent(fixture.root)
    expect(secondResult.outcome).toBe(PATCH_OUTCOME.ALREADY_PATCHED)
    expect(classifyNodePtyConsoleListAgent(fixture.root).outcome).toBe(
      PATCH_OUTCOME.ALREADY_PATCHED
    )
    expect(readFileSync(fixture.agentPath, 'utf8')).toBe(once)
  })

  it('degrades instead of throwing on unexpected source or version drift (fail-open)', () => {
    // Unexpected source: neither the recognized original nor patched sha. The sha gate must REFUSE
    // to mutate it — degrade (skip) and leave the source byte-for-byte unchanged, never patched.
    const driftedSource = `${publishedAgentSource()}\n// drift`
    const drifted = writeNodePtyFixture('1.1.0', driftedSource)
    const driftResult = patchNodePtyConsoleListAgent(drifted.root)
    expect(driftResult.outcome).toBe(PATCH_OUTCOME.SKIPPED_UNEXPECTED_SOURCE)
    expect(driftResult.sha256Prefix).toMatch(/^[0-9a-f]{12}$/)
    expect(readFileSync(drifted.agentPath, 'utf8')).toBe(driftedSource)

    // Unexpected version: the pinned 1.1.0-specific patch cannot apply; degrade with a distinct
    // outcome so internal pin-drift stays visible in telemetry. Source stays unchanged.
    const wrongVersion = writeNodePtyFixture('1.2.0-beta.11', publishedAgentSource())
    const versionResult = patchNodePtyConsoleListAgent(wrongVersion.root)
    expect(versionResult.outcome).toBe(PATCH_OUTCOME.SKIPPED_UNEXPECTED_VERSION)
    expect(versionResult.version).toBe('1.2.0-beta.11')
    expect(readFileSync(wrongVersion.agentPath, 'utf8')).toBe(publishedAgentSource())
  })

  it('still reports the patched fallback as not installed after tampering', () => {
    const tamperedPatch = writeNodePtyFixture('1.1.0', publishedAgentSource())
    patchNodePtyConsoleListAgent(tamperedPatch.root)
    writeFileSync(tamperedPatch.agentPath, `${readFileSync(tamperedPatch.agentPath)}\n// drift`)
    expect(() => assertPatchedNodePtyConsoleListAgent(tamperedPatch.root)).toThrow('not installed')
  })
})

function writeNodePtyFixture(version, agentSource) {
  const root = mkdtempSync(join(projectDir, '.node-pty-console-list-patch-test-'))
  cleanupDirs.push(root)
  const nodePtyDir = join(root, 'node_modules', 'node-pty')
  const libDir = join(nodePtyDir, 'lib')
  const agentPath = join(libDir, 'conpty_console_list_agent.js')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(nodePtyDir, 'package.json'), JSON.stringify({ version }))
  writeFileSync(agentPath, agentSource)
  return { root, agentPath }
}

function publishedAgentSource() {
  return [
    '"use strict";',
    '/**',
    ' * Copyright (c) 2019, Microsoft Corporation (MIT License).',
    ' *',
    ' * This module fetches the console process list for a particular PID. It must be',
    ' * called from a different process (child_process.fork) as there can only be a',
    ' * single console attached to a process.',
    ' */',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'var utils_1 = require("./utils");',
    "var getConsoleProcessList = utils_1.loadNativeModule('conpty_console_list').module.getConsoleProcessList;",
    'var shellPid = parseInt(process.argv[2], 10);',
    'var consoleProcessList = getConsoleProcessList(shellPid);',
    'process.send({ consoleProcessList: consoleProcessList });',
    'process.exit(0);',
    '//# sourceMappingURL=conpty_console_list_agent.js.map'
  ].join('\n')
}
