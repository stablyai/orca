import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const hooks = readFileSync(new URL('../nsis/orca-installer-hooks.nsh', import.meta.url), 'utf8')
const processCheck = readFileSync(
  new URL('../nsis/orca-process-check.nsh', import.meta.url),
  'utf8'
)
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const upstreamChecks = readFileSync(
  join(
    dirname(builderRequire.resolve('app-builder-lib/package.json')),
    'templates/nsis/include/allowOnlyOneInstallerInstance.nsh'
  ),
  'utf8'
)

function readPowerShellProbe(source = processCheck) {
  const match = source.match(/nsExec::Exec `"\$PowerShellPath"(.*?) -(?:C|Command) "([^"\n]+)"`/)
  if (!match) {
    throw new Error('The NSIS PowerShell invocation was not found')
  }
  return { args: match[1].trim().split(/\s+/).filter(Boolean), command: match[2] }
}

describe('NSIS process-check integration', () => {
  it('loads the capability hook through the installer and uninstaller include', () => {
    expect(hooks).toContain('!include "${__FILEDIR__}/orca-process-check.nsh"')
    expect(processCheck).toMatch(/!macro customCheckAppRunning\b/)
    expect(processCheck).toContain('!include "getProcessInfo.nsh"')
    expect(processCheck).toMatch(/^Var pid$/m)
    expect(processCheck).toMatch(/^Var \/GLOBAL IsPowerShellAvailable$/m)
  })

  it('keeps upstream process selection, retries, and installation-mode handling', () => {
    expect(processCheck).toContain('!insertmacro _CHECK_APP_RUNNING')
    expect(processCheck).not.toMatch(/!macro (?:FIND_PROCESS|KILL_PROCESS|_CHECK_APP_RUNNING)\b/)
    expect(processCheck).not.toMatch(/\b(?:Stop-Process|taskkill|Set-ExecutionPolicy)\b/)
    const findProcess = upstreamChecks.match(/!macro FIND_PROCESS\b[\s\S]*?!macroend/)?.[0]
    if (!findProcess) {
      throw new Error('The upstream process finder was not found')
    }
    expect(readPowerShellProbe().args).toEqual(readPowerShellProbe(findProcess).args)
  })
})

describe.runIf(process.platform === 'win32')(
  'NSIS capability probe under Restricted policy',
  () => {
    function runProbe(arch, prefix = '') {
      const { args, command } = readPowerShellProbe()
      if (!process.env.SystemRoot) {
        throw new Error('SystemRoot is required on Windows')
      }
      return runProcessSync({
        program: join(process.env.SystemRoot, arch, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: [
          ...args,
          '-Command',
          `if ((Get-ExecutionPolicy -Scope Process) -ne 'Restricted') { exit 10 }; ${prefix}${command}`
        ],
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'Restricted'
        },
        timeoutMs: 20_000
      })
    }

    it.each(['SysWOW64', 'System32'])('%s permits the real inline process query', (arch) => {
      const result = runProbe(arch)
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
    })

    it.each(['SysWOW64', 'System32'])('%s rejects a failed process query', (arch) => {
      const result = runProbe(
        arch,
        "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName); Write-Error 'CIM unavailable' }; "
      )
      expect(result.code, result.stderr).toBe(1)
      expect(result.timedOut).toBe(false)
    })
  }
)
