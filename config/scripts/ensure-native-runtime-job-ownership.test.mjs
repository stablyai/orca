import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertNodePtyJobOwnership } = require('./node-pty-job-ownership.cjs')
const NODE_PTY_PATCH = readFileSync(
  new URL('../patches/node-pty@1.1.0.patch', import.meta.url),
  'utf8'
)

const PATCHED = {
  dir: 'build/Release/',
  module: {
    listJobProcessIds: () => [],
    terminateJob: () => true,
    assignCurrentProcessToJob: () => true
  }
}
const PREBUILD = {
  dir: 'prebuilds/win32-x64/',
  module: {
    startProcess: () => {},
    connect: () => {},
    resize: () => {},
    clear: () => {},
    kill: () => {}
  }
}

describe('assertNodePtyJobOwnership', () => {
  it('keeps node-addon-api project paths absolute during Windows source builds', () => {
    expect(NODE_PTY_PATCH).toContain(
      `+      "<!(node -p \\"require.resolve('node-addon-api/node_addon_api.gyp')\\"):node_addon_api_except"`
    )
  })

  it('leaves the unchanged Windows helper and fallback on their upstream prebuilds', () => {
    expect(NODE_PTY_PATCH).toContain("-          'target_name': 'conpty_console_list'")
    expect(NODE_PTY_PATCH).toContain("-          'target_name': 'pty'")
  })

  it('rejects the prebuild that shipped without the job exports', () => {
    expect(() =>
      assertNodePtyJobOwnership({ platform: 'win32', nativeName: 'conpty', native: PREBUILD })
    ).toThrow(/listJobProcessIds, terminateJob, assignCurrentProcessToJob/)
  })

  it('names where the bad native came from, so the fix is obvious', () => {
    expect(() =>
      assertNodePtyJobOwnership({ platform: 'win32', nativeName: 'conpty', native: PREBUILD })
    ).toThrow(/prebuilds\/win32-x64/)
  })

  it('accepts a source build carrying the patch', () => {
    expect(() =>
      assertNodePtyJobOwnership({ platform: 'win32', nativeName: 'conpty', native: PATCHED })
    ).not.toThrow()
  })

  it.each([
    ['non-Windows hosts', { platform: 'darwin', nativeName: 'pty' }],
    ['the pre-ConPTY winpty backend', { platform: 'win32', nativeName: 'pty' }]
  ])('stays out of the way on %s', (_case, spec) => {
    expect(() => assertNodePtyJobOwnership({ ...spec, native: PREBUILD })).not.toThrow()
  })
})
