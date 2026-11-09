import { describe, expect, it } from 'vitest'
import { classifyLinkedFile } from './launchable-file-type'

const PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.RUNME'
const TEXT = new TextEncoder().encode('echo hi\n')
const SHEBANG = new TextEncoder().encode('#!/bin/sh\necho hi\n')
const MACH_O = Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1)
const ELF = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0)
const PE = Uint8Array.of(0x4d, 0x5a, 0x90, 0)
const PDF = new TextEncoder().encode('%PDF-1.7\n')
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d)
const UTF16 = Uint8Array.of(0xff, 0xfe, 0x57, 0, 0x72, 0)
const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0)
// Archive headers with no NUL byte in view: content must still not read as text.
const ZIP_NO_NUL = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0x08, 0x08, 0x08)
const GZIP_NO_NUL = Uint8Array.of(0x1f, 0x8b, 0x08, 0x08, 0x41, 0x42, 0x43, 0x44)
const BZIP2 = new TextEncoder().encode('BZh91AY&SY')

type Row = [
  platform: NodeJS.Platform,
  names: string[],
  kind: 'file' | 'dir',
  mode: number,
  head: Uint8Array,
  expected: ReturnType<typeof classifyLinkedFile>
]

describe('classifyLinkedFile', () => {
  it.each<Row>([
    // Text scripts and launchers open in Orca.
    ['darwin', ['/x/run.sh'], 'file', 0o644, TEXT, 'view-as-text'],
    ['darwin', ['/x/run.command'], 'file', 0o755, SHEBANG, 'view-as-text'],
    ['darwin', ['/x/tool.py'], 'file', 0o644, SHEBANG, 'view-as-text'],
    ['linux', ['/x/build.mjs'], 'file', 0o644, TEXT, 'view-as-text'],
    ['linux', ['/x/index.ts'], 'file', 0o644, TEXT, 'view-as-text'],
    ['linux', ['/x/app.desktop'], 'file', 0o644, TEXT, 'view-as-text'],
    ['win32', ['C:\\x\\run.BAT'], 'file', 0o644, TEXT, 'view-as-text'],
    ['win32', ['C:\\x\\setup.ps1'], 'file', 0o644, UTF16, 'view-as-text'],
    ['win32', ['C:\\x\\tool.runme'], 'file', 0o644, TEXT, 'view-as-text'],
    // Binaries, bundles and installers are revealed.
    ['win32', ['C:\\x\\setup.exe'], 'file', 0o644, PE, 'reveal'],
    ['win32', ['C:\\x\\trick.exe. .'], 'file', 0o644, PE, 'reveal'],
    ['win32', ['C:\\x\\a.exe:stream'], 'file', 0o644, PE, 'reveal'],
    ['win32', ['C:\\x\\link.lnk'], 'file', 0o644, Uint8Array.of(0x4c, 0, 0, 0), 'reveal'],
    ['darwin', ['/Applications/Tool.app'], 'dir', 0o755, new Uint8Array(), 'reveal'],
    ['darwin', ['/x/disk.dmg'], 'file', 0o644, Uint8Array.of(0x78, 0x01, 0, 0), 'reveal'],
    ['linux', ['/x/tool.AppImage'], 'file', 0o755, ELF, 'reveal'],
    ['linux', ['/x/index.ts'], 'file', 0o644, Uint8Array.of(0x47, 0, 0x11), 'reveal'],
    // Archives and packages are revealed rather than unpacked by the OS default app.
    ['darwin', ['/x/build.zip'], 'file', 0o644, ZIP, 'reveal'],
    ['darwin', ['/x/build.ZIP'], 'file', 0o644, TEXT, 'reveal'],
    ['linux', ['/x/src.tar'], 'file', 0o644, TEXT, 'reveal'],
    ['linux', ['/x/src.tar.gz'], 'file', 0o644, GZIP_NO_NUL, 'reveal'],
    ['linux', ['/x/src.tgz'], 'file', 0o644, GZIP_NO_NUL, 'reveal'],
    ['linux', ['/x/src.tar.bz2'], 'file', 0o644, BZIP2, 'reveal'],
    ['linux', ['/x/src.tbz2'], 'file', 0o644, BZIP2, 'reveal'],
    ['linux', ['/x/src.tar.xz'], 'file', 0o644, ZIP, 'reveal'],
    ['linux', ['/x/src.txz'], 'file', 0o644, ZIP, 'reveal'],
    ['linux', ['/x/src.tar.zst'], 'file', 0o644, ZIP, 'reveal'],
    ['win32', ['C:\\x\\files.7z'], 'file', 0o644, ZIP, 'reveal'],
    ['win32', ['C:\\x\\files.rar'], 'file', 0o644, ZIP, 'reveal'],
    ['win32', ['C:\\x\\files.cab'], 'file', 0o644, ZIP, 'reveal'],
    ['win32', ['C:\\x\\files.zip. .'], 'file', 0o644, ZIP, 'reveal'],
    ['linux', ['/x/app.jar'], 'file', 0o644, ZIP, 'reveal'],
    ['linux', ['/x/app.war'], 'file', 0o644, ZIP, 'reveal'],
    ['darwin', ['/x/app.ipa'], 'file', 0o644, ZIP, 'reveal'],
    ['darwin', ['/x/ext.vsix'], 'file', 0o644, ZIP, 'reveal'],
    ['win32', ['C:\\x\\pkg.nupkg'], 'file', 0o644, ZIP, 'reveal'],
    ['darwin', ['/x/notes.txt', '/x/real/build.zip'], 'file', 0o644, ZIP, 'reveal'],
    // Archive content under a script name or an extensionless +x name is not shown as text.
    ['darwin', ['/x/run.sh'], 'file', 0o644, ZIP_NO_NUL, 'reveal'],
    ['linux', ['/x/build.mjs'], 'file', 0o644, GZIP_NO_NUL, 'reveal'],
    ['darwin', ['/x/bin/bundle'], 'file', 0o755, ZIP_NO_NUL, 'reveal'],
    ['darwin', ['/x/bin/bundle'], 'file', 0o755, BZIP2, 'reveal'],
    // Archive content under a document name opens by that name, as before.
    ['darwin', ['/x/report.docx'], 'file', 0o644, ZIP, 'open'],
    // Executable bit: content decides for extensionless files.
    ['darwin', ['/x/bin/tool'], 'file', 0o755, MACH_O, 'reveal'],
    ['darwin', ['/x/bin/deploy'], 'file', 0o755, SHEBANG, 'view-as-text'],
    ['darwin', ['/x/bin/plain'], 'file', 0o755, TEXT, 'view-as-text'],
    ['linux', ['/x/elf-binary'], 'file', 0o700, ELF, 'reveal'],
    // Executable bit on a typed name: scripts and programs are caught, documents open by type.
    ['darwin', ['/x/notes.md'], 'file', 0o755, SHEBANG, 'view-as-text'],
    ['linux', ['/x/readme.txt'], 'file', 0o755, ELF, 'reveal'],
    ['darwin', ['/mnt/share/report.pdf'], 'file', 0o777, PDF, 'open'],
    ['darwin', ['/mnt/share/photo.png'], 'file', 0o777, PNG, 'open'],
    ['linux', ['/mnt/share/notes.md'], 'file', 0o777, TEXT, 'open'],
    // Symlinks are judged by every name in the chain.
    ['darwin', ['/x/notes.txt', '/x/real/run.sh'], 'file', 0o644, TEXT, 'view-as-text'],
    ['darwin', ['/x/notes.txt', '/x/real/Tool.app'], 'dir', 0o755, new Uint8Array(), 'reveal'],
    ['darwin', ['/x/report.pdf', '/x/real/tool'], 'file', 0o755, MACH_O, 'reveal'],
    ['darwin', ['/x/run.sh', '/x/real/notes.txt'], 'file', 0o644, TEXT, 'view-as-text'],
    // Documents and folders are unchanged.
    ['darwin', ['/x/docs'], 'dir', 0o755, new Uint8Array(), 'open'],
    ['darwin', ['/x/report.pdf'], 'file', 0o644, PDF, 'open'],
    ['darwin', ['/x/script-notes'], 'file', 0o644, SHEBANG, 'open'],
    ['linux', ['/x/page.html'], 'file', 0o644, TEXT, 'open'],
    ['win32', ['C:\\x\\notes.md'], 'file', 0o755, SHEBANG, 'open']
  ])('%s %j %s %o -> %s', (platform, names, kind, mode, head, expected) => {
    const facts = {
      names,
      isFile: kind === 'file',
      isDirectory: kind === 'dir',
      mode,
      head
    }
    expect(classifyLinkedFile(facts, platform, PATHEXT)).toBe(expected)
  })
})
