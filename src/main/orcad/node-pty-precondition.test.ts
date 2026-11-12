import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildNodePtyLoadProbeScript,
  checkNodePtyPrecondition,
  classifyNodePtyProbeResult
} from './node-pty-precondition'

const require = createRequire(import.meta.url)
const REAL_NODE_PTY = dirname(require.resolve('node-pty/package.json'))
const REAL_PTY_NODE = join(REAL_NODE_PTY, 'build', 'Release', 'pty.node')

// Probe real binding loads in a child: file presence can hide an Electron/Node ABI mismatch.
const REAL_SPAWN_HELPER = join(REAL_NODE_PTY, 'build', 'Release', 'spawn-helper')

const realNodePtyLoads = ((): boolean => {
  if (!existsSync(REAL_PTY_NODE)) {
    return false
  }
  // Only macOS builds spawn-helper; load-success tests there must also require it.
  if (process.platform === 'darwin' && !existsSync(REAL_SPAWN_HELPER)) {
    return false
  }
  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(REAL_PTY_NODE)})`], {
    encoding: 'utf8',
    timeout: 30_000
  })
  return !probe.error && probe.status === 0
})()

const probe = (overrides: Partial<Parameters<typeof classifyNodePtyProbeResult>[0]> = {}) =>
  classifyNodePtyProbeResult({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  })

describe('classifyNodePtyProbeResult', () => {
  it('accepts only a clean exit that printed the token', () => {
    expect(probe({ code: 0, stdout: 'ORCA_NODE_PTY_LOAD_OK /x/build/Release' })).toBeNull()
    expect(probe({ code: 0, stdout: '' })?.reason).toBe('load_failed')
  })

  it('reports a signalled probe as a crash, even with no output at all', () => {
    expect(probe({ code: null, signal: 'SIGSEGV' })).toEqual({
      status: 'blocked',
      reason: 'load_crashed',
      detail: 'the load probe was killed by SIGSEGV'
    })
  })

  it('ignores its own token strings echoed back inside the child stderr', () => {
    // Node echoes eval source into stderr; matching its tokens would misclassify loader failure.
    const echoedSource =
      '[eval]:1\nif(!f){console.log("ORCA_NODE_PTY_NO_BINARY");process.exit(3)}\n' +
      '        ^\n\nError: dlopen(/app/pty.node): slice is not valid mach-o file\n'

    expect(
      classifyNodePtyProbeResult({
        code: 4,
        signal: null,
        stdout: `ORCA_NODE_PTY_LOAD_ERROR ${JSON.stringify('dlopen(/app/pty.node): slice is not valid mach-o file')}`,
        stderr: echoedSource,
        timedOut: false
      })
    ).toMatchObject({ reason: 'load_failed' })
  })

  it('calls a timeout unverifiable rather than blocked', () => {
    expect(probe({ timedOut: true })).toEqual({
      status: 'unverifiable',
      reason: 'unknown',
      detail: 'the node-pty load probe did not finish in time, so nothing was established'
    })
  })
})

describe('buildNodePtyLoadProbeScript', () => {
  it('uses build 17763 only when the bundled ConPTY DLL is on', () => {
    const dir = '/opt/app/node_modules/node-pty'
    const withDll = buildNodePtyLoadProbeScript(dir, { useConptyDll: true })
    const withoutDll = buildNodePtyLoadProbeScript(dir, { useConptyDll: false })
    expect(withDll).toContain('>=17763?')
    expect(withDll).not.toContain('18309')
    expect(withoutDll).toContain('>=18309?')
    expect(withoutDll).not.toContain('17763')
    expect(buildNodePtyLoadProbeScript(dir)).toBe(withoutDll)
  })
})

describe('checkNodePtyPrecondition', () => {
  const temporaryDirs: string[] = []
  const stageNodePty = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-node-pty-'))
    temporaryDirs.push(root)
    const dir = join(root, 'node-pty')
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'lib'), join(dir, 'lib'), { recursive: true })
    cpSync(join(REAL_NODE_PTY, 'package.json'), join(dir, 'package.json'))
    return dir
  }

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // This load-outcome assertion needs a real Node-ABI binding and macOS-only spawn-helper.
  it.runIf(process.platform === 'darwin' && realNodePtyLoads)(
    'degrades rather than blocks when only spawn-helper is missing',
    () => {
      const dir = stageNodePty()
      cpSync(
        join(REAL_NODE_PTY, 'build', 'Release', 'pty.node'),
        join(dir, 'build', 'Release', 'pty.node')
      )

      const verdict = checkNodePtyPrecondition({ nodePtyDir: dir, prebuildsDir: null })

      expect(verdict).toMatchObject({ status: 'degraded', reason: 'spawn_helper_missing' })
    }
  )

  // Simulate Linux to prove it never requires macOS-only spawn-helper; require a loadable binding.

  // Placement works with fake payloads; successful load outcomes require a prepared real binding.
})
