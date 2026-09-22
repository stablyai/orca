import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { peImage } from './windows-pe-image-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  CYGWIN_BREAKAWAY_MARKER,
  CYGWIN_BREAKAWAY_MARKER_TEXT,
  assertNodePtyJobOwnership,
  assertRebuiltConptyDeniesMsysBreakaway,
  nodePtyAddonPath
} = require('./node-pty-job-ownership.cjs')
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
      cygwinBreakawayDenied ? CYGWIN_BREAKAWAY_MARKER : Buffer.alloc(0)
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

  // The gate's whole case rests on this literal, and nothing else ties the
  // constant to the C++ that compiles it in. Drift either way has to fail HERE:
  // otherwise it fails every correctly rebuilt addon, and no rebuild can fix it.
  it('sniffs for a literal the patch really adds to conpty.cc', () => {
    const conptyHunk = NODE_PTY_PATCH.split(/^diff --git /m).find((section) =>
      section.startsWith('a/src/win/conpty.cc ')
    )
    expect(conptyHunk, 'the patch no longer touches src/win/conpty.cc').toBeDefined()
    const addedCode = conptyHunk
      .split('\n')
      .filter((line) => line.startsWith('+') && !/^\+\s*(\/\/|\*)/.test(line))
    expect(
      addedCode.some((line) => line.includes(`L"${CYGWIN_BREAKAWAY_MARKER_TEXT}"`)),
      `No added conpty.cc line carries L"${CYGWIN_BREAKAWAY_MARKER_TEXT}". Either the patch ` +
        'stopped adding it or CYGWIN_BREAKAWAY_MARKER_TEXT drifted; until they agree the gate ' +
        'rejects every correctly rebuilt addon.'
    ).toBe(true)
  })

  // MSVC compiles L"" to UTF-16LE; reading the addon as anything else finds nothing.
  it('looks for that literal in the encoding the compiler stores it in', () => {
    expect(CYGWIN_BREAKAWAY_MARKER.toString('utf16le')).toBe(CYGWIN_BREAKAWAY_MARKER_TEXT)
    expect(CYGWIN_BREAKAWAY_MARKER.length).toBe(CYGWIN_BREAKAWAY_MARKER_TEXT.length * 2)
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

  // Passing the conpty name and no readable addon: on win32 every remaining
  // branch throws, so only the platform gate can keep these quiet. The MSYS
  // breakaway denial is a Windows concern and must cost other hosts nothing.
  it.each([
    ['non-Windows hosts', { platform: 'darwin', nativeName: 'conpty' }],
    ['non-Windows hosts building for one', { platform: 'linux', nativeName: 'conpty' }],
    ['the pre-ConPTY winpty backend', { platform: 'win32', nativeName: 'pty' }]
  ])('stays out of the way on %s', (_case, spec) => {
    expect(() => assertNodePtyJobOwnership({ ...spec, native: PREBUILD })).not.toThrow()
  })

  it('would have thrown on Windows for the very same input', () => {
    expect(() =>
      assertNodePtyJobOwnership({ platform: 'win32', nativeName: 'conpty', native: PREBUILD })
    ).toThrow()
  })
})

describe('nodePtyAddonPath', () => {
  // Built from segments rather than a POSIX string: on Windows `resolve` returns
  // a drive letter and backslashes, so a literal only ever passed off Windows.
  it('resolves the addon against node-pty lib, which is the only base callers share', () => {
    expect(
      nodePtyAddonPath(
        resolve('/app/node_modules/node-pty/lib/utils.js'),
        { dir: '../build/Release/' },
        'conpty'
      )
    ).toBe(join(resolve('/app/node_modules/node-pty'), 'build', 'Release', 'conpty.node'))
  })

  it('handles the bundled layout, where the addon sits beside lib', () => {
    expect(
      nodePtyAddonPath(
        resolve('/app/resources/node-pty/lib/utils.js'),
        { dir: './build/Release/' },
        'conpty'
      )
    ).toBe(join(resolve('/app/resources/node-pty/lib'), 'build', 'Release', 'conpty.node'))
  })
})

describe('assertRebuiltConptyDeniesMsysBreakaway', () => {
  const rebuiltInto = (files) => {
    const nodePtyDir = join(mkdtempSync(join(fixtureDir, 'rebuild-')), 'node-pty')
    for (const [relativePath, options] of Object.entries(files)) {
      const { arch = 'x64', cygwinBreakawayDenied = true } = options
      const addonPath = join(nodePtyDir, ...relativePath.split('/'))
      mkdirSync(dirname(addonPath), { recursive: true })
      writeFileSync(
        addonPath,
        Buffer.concat([
          peImage({ arch }),
          cygwinBreakawayDenied ? CYGWIN_BREAKAWAY_MARKER : Buffer.alloc(0)
        ])
      )
    }
    return nodePtyDir
  }

  it('accepts the addon a good same-host rebuild leaves behind', () => {
    const nodePtyDir = rebuiltInto({ 'build/Release/conpty.node': {} })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'x64', crossHost: false })
    ).not.toThrow()
  })

  it('rejects one that predates the denial, wherever the rebuild ran', () => {
    const nodePtyDir = rebuiltInto({
      'build/Release/conpty.node': { cygwinBreakawayDenied: false }
    })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'x64', crossHost: true })
    ).toThrow(/predates the Cygwin\/MSYS job-breakaway denial/)
  })

  // On the host that will run this install, no addon means loadNativeModule
  // falls through to the published prebuild -- the binary that leaks every MSYS
  // pane child. That is a broken build, not an absence to shrug at.
  it('refuses a same-host rebuild that reported success and produced nothing', () => {
    const nodePtyDir = rebuiltInto({ 'package.json': {} })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'x64', crossHost: false })
    ).toThrow(/the rebuild reported success/)
  })

  it('names both the addon it wanted and the prebuild that would load instead', () => {
    const nodePtyDir = rebuiltInto({ 'package.json': {} })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'arm64', crossHost: false })
    ).toThrow(/build[\\/]Release[\s\S]*prebuilds[\\/]win32-arm64/)
  })

  // A rebuild that ignored --arch leaves a binary the target cannot load, so
  // node-pty falls back to the prebuild. Saying so here is two steps closer to
  // the command that fixes it than saying so at packaging time.
  it('rejects an addon of an architecture this rebuild did not target', () => {
    const nodePtyDir = rebuiltInto({ 'build/Release/conpty.node': { arch: 'x64' } })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'arm64', crossHost: true })
    ).toThrow(/machine 0x8664, but this rebuild targets win32-arm64/)
  })

  // "node-gyp ignored --arch" is a guess when the file is not a PE at all: that
  // is a truncated or quarantined artifact, and saying otherwise sends the
  // reader to the wrong command.
  it('does not blame --arch for a file that is not a PE image', () => {
    const nodePtyDir = join(mkdtempSync(join(fixtureDir, 'rebuild-')), 'node-pty')
    mkdirSync(join(nodePtyDir, 'build', 'Release'), { recursive: true })
    writeFileSync(join(nodePtyDir, 'build', 'Release', 'conpty.node'), Buffer.alloc(0x200))
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'x64', crossHost: false })
    ).toThrow(/is not a PE image[\s\S]*truncated or quarantined/)
  })

  it('still names the consequence for that file, which is the prebuild', () => {
    const nodePtyDir = join(mkdtempSync(join(fixtureDir, 'rebuild-')), 'node-pty')
    mkdirSync(join(nodePtyDir, 'build', 'Release'), { recursive: true })
    writeFileSync(join(nodePtyDir, 'build', 'Release', 'conpty.node'), Buffer.alloc(0x200))
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'x64', crossHost: false })
    ).toThrow(/fall back to the published prebuild/)
  })

  it('accepts one a cross-arch rebuild really did emit for the target', () => {
    const nodePtyDir = rebuiltInto({ 'build/Release/conpty.node': { arch: 'arm64' } })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'arm64', crossHost: true })
    ).not.toThrow()
  })

  // PE_MACHINE covers what Orca ships; an arch it does not know is not one this
  // can judge, and guessing would fail a rebuild that was fine.
  it('does not judge an architecture it has no machine value for', () => {
    const nodePtyDir = rebuiltInto({ 'build/Release/conpty.node': { arch: 'x64' } })
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({ nodePtyDir, rebuildArch: 'ia32', crossHost: true })
    ).not.toThrow()
  })

  it.each([
    ['a cross-host rebuild need not leave a win32 addon here', { crossHost: true }, true],
    ['no node-pty on this disk is not a bad build', { crossHost: false }, false]
  ])('warns instead: %s', (_case, verdict, nodePtyInstalled) => {
    const nodePtyDir = nodePtyInstalled
      ? rebuiltInto({ 'package.json': {} })
      : join(fixtureDir, 'no-node-pty-here')
    const warn = vi.fn()
    expect(() =>
      assertRebuiltConptyDeniesMsysBreakaway({
        nodePtyDir,
        rebuildArch: 'x64',
        ...verdict,
        warn
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check the MSYS'))
  })
})
