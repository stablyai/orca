import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx']

// The exact shape app-builder-lib's APP_ASSOCIATE emits: a write to the DEFAULT ("")
// value of Software\Classes\.<ext>. Additive `WriteRegNone ...\OpenWithProgids` must not
// match, or the guard below would be unfalsifiable.
const DEFAULT_HANDLER_WRITE = /WriteRegStr\s+SHELL_CONTEXT\s+"Software\\Classes\\\.[a-z]+"\s+""/i

// The hooks file documents the forbidden line in prose, so match executable script only.
const stripNsisCommentLines = (source) =>
  source
    .split('\n')
    .filter((line) => !/^\s*[;#]/.test(line))
    .join('\n')

const readInstallerHooks = () => readFile(electronBuilderConfig.nsis.include, 'utf8')

describe('electron-builder markdown file associations', () => {
  // Why: any top-level (or `win.`) fileAssociations entry makes app-builder-lib's NSIS
  // packager emit `!insertmacro APP_ASSOCIATE`, whose first line writes that DEFAULT value
  // — silently taking .md from whichever editor owns it, for every existing user on their
  // next UPDATE, with APP_UNASSOCIATE never restoring it. `rank: 'Alternate'` cannot
  // prevent this; it is LSHandlerRank and applies to macOS only. So the mac block must
  // stay under `mac.` — hoisting it up "to share it with Windows" is what this test blocks.
  it('never claims the Windows default markdown handler', () => {
    expect(electronBuilderConfig.fileAssociations).toBeUndefined()
    expect(electronBuilderConfig.win?.fileAssociations).toBeUndefined()
  })

  it('joins the macOS Open With list for every markdown extension without owning it', () => {
    const associations = electronBuilderConfig.mac.fileAssociations
    // One entry per extension: an array `ext` would break the Linux packager's `*.${ext}` glob.
    expect([...associations].map((association) => association.ext).sort()).toEqual(
      [...MARKDOWN_EXTENSIONS].sort()
    )
    for (const association of associations) {
      expect(association).toMatchObject({ role: 'Editor', rank: 'Alternate' })
    }
  })

  // Why mimeTypes and not linux.fileAssociations: shared-mime-info already maps markdown to
  // text/markdown, so the desktop entry only adds a handler and mimeapps.list keeps owning
  // the default. A fileAssociations entry would ship a redundant glob override instead.
  it('reuses the existing shared-mime-info markdown type on Linux', () => {
    expect(electronBuilderConfig.linux.mimeTypes).toContain('text/markdown')
    expect(electronBuilderConfig.linux.fileAssociations).toBeUndefined()
  })

  it('points the single NSIS include at the installer hooks file on disk', () => {
    const includePath = electronBuilderConfig.nsis.include
    expect(existsSync(includePath)).toBe(true)
    expect(basename(includePath)).toBe('orca-installer-hooks.nsh')
  })

  // Guard for the guard: proves DEFAULT_HANDLER_WRITE really matches a takeover line, so
  // the assertion below is a live check rather than a regex that can never fire.
  it('recognizes an APP_ASSOCIATE-style default-handler write', () => {
    for (const takeover of [
      '  WriteRegStr SHELL_CONTEXT "Software\\Classes\\.md" "" "Orca.Markdown"',
      'WriteRegStr  SHELL_CONTEXT  "Software\\Classes\\.markdown"  ""  "$0"'
    ]) {
      expect(takeover).toMatch(DEFAULT_HANDLER_WRITE)
    }
    expect(
      'WriteRegNone SHELL_CONTEXT "Software\\Classes\\.md\\OpenWithProgids" "Orca.Markdown"'
    ).not.toMatch(DEFAULT_HANDLER_WRITE)
    // Comment stripping must drop prose that quotes the bad line without swallowing a real
    // one that happens to carry a trailing comment.
    const stripped = stripNsisCommentLines(
      [
        ';   WriteRegStr SHELL_CONTEXT "Software\\Classes\\.md" "" "<ProgID>"',
        '  WriteRegStr SHELL_CONTEXT "Software\\Classes\\.md" "" "$0" ; oops'
      ].join('\n')
    )
    expect(stripped.split('\n')).toHaveLength(1)
    expect(stripped).toMatch(DEFAULT_HANDLER_WRITE)
  })

  it('registers Windows markdown Open With additively, never as the default', async () => {
    const hooks = await readInstallerHooks()

    expect(stripNsisCommentLines(hooks)).not.toMatch(DEFAULT_HANDLER_WRITE)
    // The additive hint that puts Orca in Explorer's "Open with" list.
    expect(hooks).toMatch(
      /WriteRegNone\s+SHELL_CONTEXT\s+"Software\\Classes\\\$\{EXT\}\\OpenWithProgids"/
    )
    expect(hooks).toMatch(/!macro\s+ORCA_REGISTER_MARKDOWN_OPEN_WITH\s+EXT/)
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(hooks).toContain(`ORCA_REGISTER_MARKDOWN_OPEN_WITH ".${ext}"`)
      expect(hooks).toContain(`ORCA_UNREGISTER_MARKDOWN_OPEN_WITH ".${ext}"`)
    }
    expect(hooks).toMatch(/!macro\s+customInstall\b/)
    expect(hooks).toMatch(/!macro\s+customUnInstall\b/)
  })

  // Why: this include was renamed from daemon-host-uninstall.nsh to carry the markdown
  // hooks too. electron-builder allows only one include, so a merge that drops the daemon
  // sweep would silently orphan a running daemon host on every uninstall.
  //
  // Asserted against comment-stripped script, and on the app exe name first: the relocated
  // host is a verbatim copy of the app exe (daemonHostExeName, daemon-host-relocation.ts),
  // so a macro that kills only orca-terminal-daemon.exe matches no running process. The
  // prose above the macro names both, so a toContain over the raw file proves nothing.
  it('keeps the daemon-host uninstall sweep across the include rename', async () => {
    const script = stripNsisCommentLines(await readInstallerHooks())

    expect(script).toMatch(/taskkill[^\n]*\/IM\s+"?\$\{APP_EXECUTABLE_FILENAME\}"?/)
    // Legacy name, so hosts left by builds that renamed the copy still get reaped.
    expect(script).toMatch(/taskkill[^\n]*\/IM\s+"?orca-terminal-daemon\.exe"?/)
    // Scopes both kills to the uninstalling user: an elevated machine-wide uninstall must
    // not reach another logged-on user's session.
    expect(script).toMatch(/\/FI\s+"USERNAME eq /)
    expect(script).toContain('$LOCALAPPDATA\\Orca\\daemon-host')
    // Without this guard, uninstallOldVersion would kill the daemon on every update —
    // defeating the relocation that keeps terminals alive across updates.
    expect(script).toMatch(/\$\{ifNot\}\s+\$\{isUpdated\}/)
  })
})
