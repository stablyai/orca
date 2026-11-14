import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { selectPluginTestNode } from './plugin-test-node'

const { runDefault, packaged } = vi.hoisted(() => {
  const packaged: { path: string | null } = { path: null }
  return { runDefault: vi.fn(), packaged }
})
vi.mock('@orca/process-host', () => ({ runProcess: runDefault }))
vi.mock('../../runtime/packaged-cli-interpreter', () => ({
  getPackagedElectronExecutable: () => packaged.path
}))
afterEach(() => {
  packaged.path = null
  vi.clearAllMocks()
})

const ORCA = { execPath: '/Applications/Orca.app/Contents/MacOS/Orca', version: 'v22.9.0' }

function answering(stdout: string | Error, code = 0) {
  const specs: ProcessSpec[] = []
  const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
    specs.push(spec)
    if (stdout instanceof Error) {
      throw stdout
    }
    return { code, signal: null, stdout, stderr: '', timedOut: false }
  }
  return { run, specs }
}

describe('selectPluginTestNode', () => {
  it('uses root Electron for the fallback child while the packaged CLI runs on Node', async () => {
    packaged.path = '/Applications/Orca.app/Contents/MacOS/Orca'
    runDefault.mockRejectedValue(new Error('spawn node ENOENT'))
    expect(await selectPluginTestNode()).toMatchObject({
      program: '/Applications/Orca.app/Contents/MacOS/Orca',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'orca'
    })
  })

  it('uses a new enough system node by the absolute path it reports, probed outside the plugin', async () => {
    const probe = answering('v20.6.0 /usr/local/bin/node\n')
    const node = await selectPluginTestNode({ ...ORCA, electron: true, run: probe.run })
    expect(node).toEqual({
      program: '/usr/local/bin/node',
      env: {},
      source: 'system',
      version: 'v20.6.0'
    })
    expect(probe.specs[0]?.program).toBe('node')
    expect(probe.specs[0]?.cwd).toMatch(/orca-plugin-node-/)
  })

  it('keeps a Windows path with spaces whole', async () => {
    const probe = answering('v22.1.0 C:\\Program Files\\nodejs\\node.exe\r\n')
    const node = await selectPluginTestNode({ ...ORCA, electron: true, run: probe.run })
    expect(node.program).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it.each([
    ['too old for module.register', answering('v20.5.1 /usr/bin/node')],
    ['not on PATH', answering(new Error('spawn node ENOENT'))],
    ['failing', answering('', 1)],
    ['answering garbage', answering('nope')]
  ])('falls back to Orca as Node when the system node is %s', async (_reason, probe) => {
    const node = await selectPluginTestNode({ ...ORCA, electron: true, run: probe.run })
    expect(node).toEqual({
      program: ORCA.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'orca',
      version: ORCA.version
    })
  })

  it('needs no Electron switch when the CLI itself runs on plain Node', async () => {
    const probe = answering(new Error('spawn node ENOENT'))
    const node = await selectPluginTestNode({ ...ORCA, electron: false, run: probe.run })
    expect(node.env).toEqual({})
  })
})
