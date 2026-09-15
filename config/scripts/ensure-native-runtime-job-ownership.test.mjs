import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertNodePtyJobOwnership, nodePtyAddonPath } = require('./node-pty-job-ownership.cjs')
const NODE_PTY_PATCH = readFileSync(
  new URL('../patches/node-pty@1.1.0.patch', import.meta.url),
  'utf8'
)

const JOB_EXPORTS = {
  listJobProcessIds: () => [],
  terminateJob: () => true,
  assignCurrentProcessToJob: () => true
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'node-pty-job-ownership-'))

/** A stand-in addon; only the wide literal the gate reads has to be real. */
function writeAddon(name, { cygwinBreakawayDenied }) {
  const path = join(fixtureDir, name)
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from('MZ fake addon '),
      cygwinBreakawayDenied ? Buffer.from('msys-2.0.dll', 'utf16le') : Buffer.alloc(0)
    ])
  )
  return path
}

const CURRENT_ADDON = writeAddon('current.node', { cygwinBreakawayDenied: true })
const PRE_MSYS_ADDON = writeAddon('pre-msys.node', { cygwinBreakawayDenied: false })

const PATCHED = { dir: 'build/Release/', module: JOB_EXPORTS }
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

const onWindows = (native, addonPath) => ({
  platform: 'win32',
  nativeName: 'conpty',
  native,
  addonPath
})

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
    expect(() => assertNodePtyJobOwnership(onWindows(PREBUILD, CURRENT_ADDON))).toThrow(
      /listJobProcessIds, terminateJob, assignCurrentProcessToJob/
    )
  })

  it('names where the bad native came from, so the fix is obvious', () => {
    expect(() => assertNodePtyJobOwnership(onWindows(PREBUILD, CURRENT_ADDON))).toThrow(
      /prebuilds\/win32-x64/
    )
  })

  it('accepts a source build carrying the patch', () => {
    expect(() => assertNodePtyJobOwnership(onWindows(PATCHED, CURRENT_ADDON))).not.toThrow()
  })

  // The reason this gate reads the binary at all: every export above predates
  // the Cygwin/MSYS breakaway denial, so a build that leaks every Git Bash
  // child out of its pane's job satisfies all of them.
  it('rejects a source build that predates the Cygwin/MSYS breakaway denial', () => {
    expect(() => assertNodePtyJobOwnership(onWindows(PATCHED, PRE_MSYS_ADDON))).toThrow(
      /predates the Cygwin\/MSYS job-breakaway denial/
    )
  })

  it('tells that build apart by path, and says to rebuild', () => {
    expect(() => assertNodePtyJobOwnership(onWindows(PATCHED, PRE_MSYS_ADDON))).toThrow(
      /pre-msys\.node[\s\S]*Rebuild node-pty from source/
    )
  })

  it.each([
    ['no path at all', undefined],
    ['a path that is not there', join(fixtureDir, 'absent.node')]
  ])('refuses rather than skip when the addon cannot be read: %s', (_case, addonPath) => {
    expect(() => assertNodePtyJobOwnership(onWindows(PATCHED, addonPath))).toThrow(
      /Cannot read node-pty's conpty native/
    )
  })

  it.each([
    ['non-Windows hosts', { platform: 'darwin', nativeName: 'pty' }],
    ['the pre-ConPTY winpty backend', { platform: 'win32', nativeName: 'pty' }]
  ])('stays out of the way on %s', (_case, spec) => {
    expect(() => assertNodePtyJobOwnership({ ...spec, native: PREBUILD })).not.toThrow()
  })
})

describe('nodePtyAddonPath', () => {
  it('resolves the addon against node-pty lib, which is the only base callers share', () => {
    expect(
      nodePtyAddonPath(
        '/app/node_modules/node-pty/lib/utils.js',
        { dir: '../build/Release/' },
        'conpty'
      )
    ).toBe('/app/node_modules/node-pty/build/Release/conpty.node')
  })

  it('handles the bundled layout, where the addon sits beside lib', () => {
    expect(
      nodePtyAddonPath(
        '/app/resources/node-pty/lib/utils.js',
        { dir: './build/Release/' },
        'conpty'
      )
    ).toBe('/app/resources/node-pty/lib/build/Release/conpty.node')
  })
})
