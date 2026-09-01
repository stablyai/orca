import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('daemon-host-uninstall.nsh', () => {
  it('uses the system icacls with a bounded least-privilege grant', () => {
    const source = readFileSync(join(__dirname, '../nsis/daemon-host-uninstall.nsh'), 'utf-8')
    const installMacro = source.match(/!macro customInstall[\s\S]*?!macroend/)?.[0]

    expect(installMacro).toContain(
      'nsExec::Exec \'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX)\''
    )
    expect(installMacro).toMatch(/nsExec::Exec[\s\S]*?Pop \$0/)
    expect(installMacro).toMatch(/\$\{If\} \$0 != "0"[\s\S]*?DetailPrint/)
    expect(installMacro).toMatch(
      /\$\{IfNot\} \$\{Silent\}[\s\S]*?MessageBox MB_OK\|MB_ICONEXCLAMATION[\s\S]*?\$\{EndIf\}/
    )
    expect(installMacro).not.toMatch(/\b(?:Abort|Quit|SetErrorLevel)\b/)
    expect(installMacro).not.toMatch(/\/T\b|\/reset\b|\(F\)|\(M\)|\(W\)/i)
    expect(installMacro).not.toMatch(/ALL APPLICATION PACKAGES/i)
  })
})
