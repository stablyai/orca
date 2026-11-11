import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
const processCheck = readFileSync(
  new URL('../../../nsis/orca-process-check.nsh', import.meta.url),
  'utf8'
)

function readPowerShellProbe(source = processCheck) {
  const match = source.match(/nsExec::Exec `"\$PowerShellPath"(.*?) -(?:C|Command) "([^"\n]+)"`/)
  if (!match) {
    throw new Error('The NSIS PowerShell invocation was not found')
  }
  return { args: match[1].trim().split(/\s+/).filter(Boolean), command: match[2] }
}

describe.runIf(process.platform === 'win32')(
  'NSIS capability probe under Restricted policy',
  () => {
    const policyReceipt = 'orca-nsis: restricted policy verified'
    const queryFailureReceipt = 'orca-nsis: injected query failure'
    const policyCheck = [
      'function Test-OrcaRestrictedPolicy { param([string]$Scope)',
      "try { $parameters = @{ ErrorAction = 'Stop' };",
      'if ($Scope) { $parameters.Scope = $Scope };',
      "return ((Get-ExecutionPolicy @parameters) -eq 'Restricted')",
      '} catch { return $false } };',
      // A failed getter must not fall through to the query's successful exit.
      "if ((Test-OrcaRestrictedPolicy '__orca_invalid_scope__') -ne $false) { exit 11 };",
      "if ((Test-OrcaRestrictedPolicy 'Process') -ne $true) { exit 10 };",
      'if ((Test-OrcaRestrictedPolicy) -ne $true) { exit 10 };',
      `[Console]::Out.WriteLine('${policyReceipt}');`
    ].join(' ')

    // Watchdog matches powershell-runner.mjs: Windows PowerShell 5.1 cold start under CI load exceeded the old 20s cap; this is no latency budget.
    const PROBE_TIMEOUT_MS = 60_000
    // Vitest's 30s default would otherwise cap the blocking spawn ahead of PROBE_TIMEOUT_MS.
    const PROBE_TEST_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15_000

    const WARM_UP_TIMEOUT_MS = 150_000
    const ARCHES = ['SysWOW64', 'System32']

    function runProbe(arch, prefix = '', timeoutMs = PROBE_TIMEOUT_MS) {
      const { args, command } = readPowerShellProbe()
      if (!process.env.SystemRoot) {
        throw new Error('SystemRoot is required on Windows')
      }
      // The pwsh runner's module path points Windows PowerShell at incompatible PS7 modules.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
      )
      return runProcessSync({
        program: join(process.env.SystemRoot, arch, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: [...args, '-Command', `${policyCheck} ${prefix}${command}`],
        env: {
          ...env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'Restricted'
        },
        timeoutMs
      })
    }

    // A fresh runner's first Get-CimInstance outlasted the watchdog; warm it once per build.
    beforeAll(
      () => {
        for (const arch of ARCHES) {
          runProbe(arch, '', WARM_UP_TIMEOUT_MS)
        }
      },
      ARCHES.length * WARM_UP_TIMEOUT_MS + 15_000
    )

    it.each(ARCHES)(
      '%s permits the real inline process query',
      { timeout: PROBE_TEST_TIMEOUT_MS },
      (arch) => {
        const result = runProbe(arch)
        expect(result.code, JSON.stringify(result)).toBe(0)
        expect(result.timedOut).toBe(false)
        expect(result.stdout).toContain(policyReceipt)
      }
    )

    it.each(ARCHES)(
      '%s rejects a failed process query',
      { timeout: PROBE_TEST_TIMEOUT_MS },
      (arch) => {
        const result = runProbe(
          arch,
          'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName); ' +
            `[Console]::Out.WriteLine('${queryFailureReceipt}'); Write-Error 'CIM unavailable' }; `
        )
        expect(result.code, JSON.stringify(result)).toBe(1)
        expect(result.timedOut).toBe(false)
        expect(result.stdout).toContain(policyReceipt)
        expect(result.stdout).toContain(queryFailureReceipt)
      }
    )
  }
)
