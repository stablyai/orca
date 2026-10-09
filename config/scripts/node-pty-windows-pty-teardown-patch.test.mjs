// The relay's copy of the ConPTY teardown release, and the guard that keeps it in lockstep with
// `config/patches/node-pty@1.1.0.patch`. pnpm patches do not cross the SSH boundary, so a relay runs
// the tree `npm install` put there, and every terminal on a Windows SSH host leaked one File handle
// for the life of the relay process.
//
// The ORDER of the conin release is the fix. Releasing it at the top of the branch -- the placement
// the desktop patch uses -- was measured at 3x WORSE than shipping nothing (File +2/terminal and a
// new Process +1/terminal); releasing it after the console-list fork and the native kill is flat.
//
// Those numbers are the `!useConptyDll` branch, which is the branch a RELAY runs. Every desktop
// site that opens a terminal pane sets `useConptyDll: true` and takes the other branch, where
// upstream already destroys the input socket. The hidden rate-limit probe
// (`src/main/rate-limits/claude-pty.ts`) does omit the option and so does run this hunk, but no
// user-visible pane does. The divergence pinned below is about which
// branch each host runs for terminals -- not about a regression in the panes users open.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertPatchedNodePtyWindowsTeardown,
  patchNodePtyWindowsTeardown
} = require('../relay-assets/node-pty-1.1.0-windows-pty-teardown-patch.cjs')
const projectDir = resolve(import.meta.dirname, '..', '..')
const cleanupDirs = []

const PATCHED_FILES = ['windowsPtyAgent.js', 'windowsTerminal.js', 'windowsConoutConnection.js']

/** The hunks config/patches/node-pty@1.1.0.patch adds to the installed desktop tree. */
const DESKTOP_HUNKS = {
  'windowsPtyAgent.js': [
    [
      [
        '                this._inSocket.readable = false;',
        '                // The non-DLL path previously only flipped `readable`, leaving the',
        '                // conin PipeWrap alive until the host exited (#947).',
        '                this._inSocket.destroy();',
        '                this._outSocket.readable = false;',
        ''
      ].join('\n'),
      [
        '                this._inSocket.readable = false;',
        '                this._outSocket.readable = false;',
        ''
      ].join('\n')
    ],
    // The useConptyDll branch, which only the DESKTOP runs -- the relay takes the
    // non-DLL branch above, where the dispose is already unconditional. Listed here
    // so un-applying still yields published; the relay asset needs no counterpart.
    [
      [
        '                // Orca: dispose unconditionally, as the non-DLL branch above does.',
        "                // Waiting for another 'data' event leaks the conout worker on every",
        '                // self-exiting shell, because no more data ever arrives (F24).',
        '                this._conoutSocketWorker.dispose();',
        ''
      ].join('\n'),
      [
        "                this._outSocket.on('data', function () {",
        '                    _this._conoutSocketWorker.dispose();',
        '                });',
        ''
      ].join('\n')
    ]
  ],
  'windowsTerminal.js': [
    [
      '        // Attach before readiness so a broken ConPTY output pipe cannot be unhandled.',
      null
    ],
    ['        // A ConPTY input-pipe error must retire only this terminal.', null]
  ]
}

function desktopPath(file) {
  return join(projectDir, 'node_modules', 'node-pty', 'lib', file)
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Windows SSH relay node-pty ConPTY teardown patch', () => {
  // Why reconstruct rather than vendor upstream: the installed tree IS the published file plus the
  // desktop's hunks, so un-applying them yields upstream exactly -- and pinning that against this
  // asset's own hashes is what fails loudly if either side of the pair moves.
  it('takes the desktop error listeners verbatim', () => {
    const fixture = writeNodePtyFixture('1.1.0')
    patchNodePtyWindowsTeardown(fixture.root)

    expect(readFileSync(join(fixture.libDir, 'windowsTerminal.js'), 'utf8')).toBe(
      readFileSync(desktopPath('windowsTerminal.js'), 'utf8')
    )
  })

  // The one hunk that must NOT match the desktop patch, and the reason is measured, not stylistic:
  // on the branch a relay runs, releasing conin before `_getConsoleProcessList()` forks aborts
  // teardown partway. Desktop terminal panes take the other branch, so no pane is affected either
  // way; what this guards is a patch sync putting the early placement onto the relay's branch.
  it('releases conin after the console-list fork, unlike the desktop patch placement', () => {
    const fixture = writeNodePtyFixture('1.1.0')
    patchNodePtyWindowsTeardown(fixture.root)
    const patched = readFileSync(join(fixture.libDir, 'windowsPtyAgent.js'), 'utf8')

    const branch = patched.slice(
      patched.indexOf('if (!this._useConptyDll) {'),
      patched.indexOf('else {', patched.indexOf('if (!this._useConptyDll) {'))
    )
    expect(branch).toContain('this._inSocket.destroy();')
    expect(branch.indexOf('this._inSocket.destroy();')).toBeGreaterThan(
      branch.indexOf('this._conoutSocketWorker.dispose();')
    )
    expect(branch.indexOf('this._inSocket.destroy();')).toBeGreaterThan(
      branch.indexOf('this._getConsoleProcessList()')
    )
    // Pinned so a future "sync the relay asset to config/patches" cannot copy the early placement
    // onto the relay's branch, where it costs +2 File and +1 Process per terminal.
    expect(patched).not.toBe(readFileSync(desktopPath('windowsPtyAgent.js'), 'utf8'))
  })

  it('installs and verifies idempotently', () => {
    const fixture = writeNodePtyFixture('1.1.0')

    patchNodePtyWindowsTeardown(fixture.root)
    const once = PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))
    for (const file of PATCHED_FILES) {
      expect(existsSync(`${join(fixture.libDir, file)}.orca-patch-${process.pid}`)).toBe(false)
    }
    expect(() => assertPatchedNodePtyWindowsTeardown(fixture.root)).not.toThrow()

    patchNodePtyWindowsTeardown(fixture.root)
    expect(PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))).toEqual(
      once
    )
  })

  it('refuses a different package version or unexpected source', () => {
    const wrongVersion = writeNodePtyFixture('1.2.0-beta.11')
    expect(() => patchNodePtyWindowsTeardown(wrongVersion.root)).toThrow('expected 1.1.0')

    for (const file of PATCHED_FILES) {
      const drifted = writeNodePtyFixture('1.1.0')
      const path = join(drifted.libDir, file)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// drift`)
      expect(() => patchNodePtyWindowsTeardown(drifted.root)).toThrow('unexpected node-pty')
    }
  })

  it('refuses a half-applied tree, so one file cannot pass for both', () => {
    for (const file of PATCHED_FILES) {
      const partial = writeNodePtyFixture('1.1.0')
      const fixture = writeNodePtyFixture('1.1.0')
      patchNodePtyWindowsTeardown(fixture.root)
      writeFileSync(join(partial.libDir, file), readFileSync(join(fixture.libDir, file), 'utf8'))
      expect(() => assertPatchedNodePtyWindowsTeardown(partial.root)).toThrow('is not installed')
    }
  })

  it.each([
    '3060c6514a8e9e3285f91b9b549930e7d25d59d4cf7e1ed3a25b9a680dd1ded5',
    '598755ee75307d041a72cd7c7c4e12ae4a4bbf35eee19da67b42b61fdae0d4d6',
    '5dfeb1dda46645e1d77964ad4d07072b34f0a897dfc7e785137cc39e755b4641'
  ])(
    'retires the known %s relay entrypoint without changing legacy input release',
    (terminalHash) => {
      const fixture = writePreviousNodePtyFixture(terminalHash)
      patchNodePtyWindowsTeardown(fixture.root)
      expect(() => assertPatchedNodePtyWindowsTeardown(fixture.root)).not.toThrow()
      expect(
        createHash('sha256')
          .update(readFileSync(join(fixture.libDir, 'windowsPtyAgent.js')))
          .digest('hex')
      ).toBe('1e23ef480569e73706e3ab4f5482c7e553c76f51414ae8e7b0bdcc2fd75f7280')
      expect(readFileSync(join(fixture.libDir, 'windowsTerminal.js'), 'utf8')).toBe(
        readFileSync(desktopPath('windowsTerminal.js'), 'utf8')
      )
      expect(readFileSync(join(fixture.libDir, 'windowsConoutConnection.js'), 'utf8')).toBe(
        readFileSync(desktopPath('windowsConoutConnection.js'), 'utf8')
      )
      const once = PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))
      patchNodePtyWindowsTeardown(fixture.root)
      expect(PATCHED_FILES.map((file) => readFileSync(join(fixture.libDir, file), 'utf8'))).toEqual(
        once
      )
    }
  )

  it('finishes every interrupted entrypoint-first downgrade', () => {
    const asset = readFileSync(
      join(projectDir, 'config', 'relay-assets', 'node-pty-1.1.0-windows-pty-teardown-patch.cjs'),
      'utf8'
    )
    const expectedOrder = ['windowsTerminal.js', 'windowsPtyAgent.js', 'windowsConoutConnection.js']
    const expectedHashes = [
      '8247ecd69be8b18257050fb026b290024612c5ffc6d492ff1d46f81e613be2cf',
      '1e23ef480569e73706e3ab4f5482c7e553c76f51414ae8e7b0bdcc2fd75f7280',
      '1440f70908fb1f55911ac8e936a1230f68a9c00c03096fcef6788eac6aad9d62'
    ]
    for (const abortAfter of [1, 2, 3]) {
      const fixture = writePreviousNodePtyFixture()
      const renamed = []
      const actualFs = require('node:fs')
      const interrupted = loadPatchTargets(asset, (name) =>
        name === 'node:fs'
          ? {
              ...actualFs,
              renameSync(from, to) {
                actualFs.renameSync(from, to)
                renamed.push(expectedOrder.find((file) => join(fixture.libDir, file) === to))
                if (renamed.length === abortAfter && abortAfter < 3) {
                  throw new Error('interrupted after actual rename')
                }
              }
            }
          : require(name)
      )
      if (abortAfter < 3) {
        expect(() => interrupted.patchNodePtyWindowsTeardown(fixture.root)).toThrow(
          'interrupted after actual rename'
        )
      } else {
        interrupted.patchNodePtyWindowsTeardown(fixture.root)
      }
      expect(renamed).toEqual(expectedOrder.slice(0, abortAfter))
      for (const [index, file] of expectedOrder.entries()) {
        const actualHash = createHash('sha256')
          .update(readFileSync(join(fixture.libDir, file)))
          .digest('hex')
        if (index < abortAfter) {
          expect(actualHash).toBe(expectedHashes[index])
        } else {
          expect(actualHash).not.toBe(expectedHashes[index])
        }
      }
      patchNodePtyWindowsTeardown(fixture.root)
      expect(() => assertPatchedNodePtyWindowsTeardown(fixture.root)).not.toThrow()
      for (const [index, file] of expectedOrder.entries()) {
        expect(
          createHash('sha256')
            .update(readFileSync(join(fixture.libDir, file)))
            .digest('hex')
        ).toBe(expectedHashes[index])
      }
      for (const file of ['windowsTerminal.js', 'windowsConoutConnection.js']) {
        expect(readFileSync(join(fixture.libDir, file), 'utf8')).toBe(
          readFileSync(desktopPath(file), 'utf8')
        )
      }
    }
  })

  it('refuses unknown downgrade source before changing any file', () => {
    for (const file of PATCHED_FILES) {
      const fixture = writePreviousNodePtyFixture()
      const path = join(fixture.libDir, file)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// unknown`)
      const before = PATCHED_FILES.map((entry) => readFileSync(join(fixture.libDir, entry), 'utf8'))
      expect(() => patchNodePtyWindowsTeardown(fixture.root)).toThrow('unexpected node-pty')
      expect(
        PATCHED_FILES.map((entry) => readFileSync(join(fixture.libDir, entry), 'utf8'))
      ).toEqual(before)
    }
  })
})

/** A published node-pty tree, rebuilt by un-applying the desktop hunks from the installed one. */
function writeNodePtyFixture(version) {
  const root = mkdtempSync(join(projectDir, '.node-pty-teardown-patch-test-'))
  cleanupDirs.push(root)
  const libDir = join(root, 'node_modules', 'node-pty', 'lib')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(root, 'node_modules', 'node-pty', 'package.json'), JSON.stringify({ version }))
  for (const file of PATCHED_FILES) {
    const desktop = readFileSync(desktopPath(file), 'utf8')
    for (const [marker] of DESKTOP_HUNKS[file] || []) {
      expect(desktop).toContain(marker)
    }
    writeFileSync(join(libDir, file), unapplyDesktopHunks(file, desktop))
  }
  return { root, libDir }
}

/**
 * Reverse of the published-to-desktop transform.
 *
 * `windowsTerminal.js` is taken verbatim from the desktop, so the asset's own replacement table is
 * the transform and reversing it is exact. `windowsPtyAgent.js` deliberately diverges, so its
 * published form is rebuilt from the desktop hunk instead -- which is also what makes this file the
 * place that notices if the desktop hunk itself ever moves.
 */
function unapplyDesktopHunks(file, desktop) {
  if (file === 'windowsPtyAgent.js') {
    let published = desktop
    for (const [patched, original] of DESKTOP_HUNKS[file]) {
      expect(published.split(patched).length - 1).toBe(1)
      published = published.replace(patched, original)
    }
    return published
  }
  const asset = readFileSync(
    join(projectDir, 'config', 'relay-assets', 'node-pty-1.1.0-windows-pty-teardown-patch.cjs'),
    'utf8'
  )
  const { PATCH_TARGETS } = loadPatchTargets(asset)
  const target = PATCH_TARGETS.find((entry) => entry.relativePath.at(-1) === file)
  expect(target).toBeDefined()
  let published = desktop
  for (const [from, to] of target.replacements.toReversed()) {
    expect(published.split(to).length - 1).toBe(1)
    published = published.replace(to, from)
  }
  return published
}

function writePreviousNodePtyFixture(
  terminalHash = '5dfeb1dda46645e1d77964ad4d07072b34f0a897dfc7e785137cc39e755b4641'
) {
  const fixture = writeNodePtyFixture('1.1.0')
  const asset = readFileSync(
    join(projectDir, 'config', 'relay-assets', 'node-pty-1.1.0-windows-pty-teardown-patch.cjs'),
    'utf8'
  )
  const { PREVIOUS_PATCH_TARGETS } = loadPatchTargets(asset)
  for (const target of PREVIOUS_PATCH_TARGETS) {
    const path = join(fixture.libDir, ...target.relativePath.slice(1))
    let source = readFileSync(path, 'utf8')
    for (const [from, to] of target.replacements) {
      expect(source.split(from).length - 1).toBe(1)
      source = source.replace(from, to)
    }
    let expectedHash = target.patchedSha256
    if (target.relativePath.at(-1) === 'windowsTerminal.js' && terminalHash !== expectedHash) {
      const variant = target.additionalPreviousVariants.find(
        (entry) => entry.sha256 === terminalHash
      )
      expect(variant).toBeDefined()
      for (const [from, to] of variant.replacements.toReversed()) {
        expect(source.split(to).length - 1).toBe(1)
        source = source.replace(to, from)
      }
      expectedHash = terminalHash
    }
    expect(createHash('sha256').update(source).digest('hex')).toBe(expectedHash)
    writeFileSync(path, source)
  }
  return fixture
}

function loadPatchTargets(assetSource, controlledRequire = require) {
  const module = { exports: {} }
  const factory = new Function(
    'module',
    'exports',
    'require',
    `${assetSource}\nmodule.exports.PATCH_TARGETS = PATCH_TARGETS; module.exports.PREVIOUS_PATCH_TARGETS = PREVIOUS_PATCH_TARGETS`
  )
  factory(module, module.exports, controlledRequire)
  return module.exports
}
