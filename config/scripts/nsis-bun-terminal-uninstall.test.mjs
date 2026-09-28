import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const hooks = readFileSync(new URL('../nsis/orca-installer-hooks.nsh', import.meta.url), 'utf8')
const source = readFileSync(
  new URL('../nsis/orca-bun-terminal-uninstall.nsh', import.meta.url),
  'utf8'
).replaceAll('\r\n', '\n')
const command = source.match(/-Command "([^"\n]+)"`/)?.[1]?.replaceAll('$$', '$')
if (!command) {
  throw new Error('Missing fixed Bun terminal uninstall command')
}

it('only cleans the dedicated Bun runtime root during genuine uninstall', () => {
  const customUninstall = hooks.match(/!macro customUnInstall\b[\s\S]*?!macroend/)?.[0]
  expect(customUninstall).toMatch(
    /\$\{ifNot\} \$\{isUpdated\}[\s\S]*?!insertmacro ORCA_UNINSTALL_BUN_TERMINAL_HOST[\s\S]*?\$\{endIf\}/
  )
  expect(source).toContain(
    '${if} $0 == 0\n    RMDir /r "$LOCALAPPDATA\\Orca\\terminal-daemon-host"'
  )
  expect(command).toContain(
    "[IO.Path]::Combine($env:LOCALAPPDATA,'Orca','terminal-daemon-host')+'\\'"
  )
  expect(command).toContain('$null=$p.Handle')
  expect(command).toContain("$p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')")
  expect(command).toContain('-MethodName GetOwnerSid')
  expect(command).not.toMatch(/taskkill|ExecutionPolicy|EncodedCommand|Add-Type/i)
  expect(source).not.toMatch(/\/IM.*bun-runtime/i)
})

const syntheticProcesses = `
if((Get-ExecutionPolicy -Scope Process) -ne 'Restricted'){exit 19};
$script:root=[IO.Path]::Combine($env:LOCALAPPDATA,'Orca','terminal-daemon-host');
$script:created=[DateTime]::Parse('2026-01-02T00:00:00Z').ToUniversalTime();
function Get-CimInstance {
  if($env:ORCA_UNINSTALL_CASE -eq 'query-failure'){throw 'query failed'};
  $image=$script:root+'\\v1\\bun-runtime.exe';
  if($env:ORCA_UNINSTALL_CASE -eq 'unrelated'){$image=$script:root+'-other\\bun-runtime.exe'};
  if($env:ORCA_UNINSTALL_CASE -eq 'unknown-image'){$image=$null};
  [pscustomobject]@{Name='bun-runtime.exe';ExecutablePath=$image;ProcessId=123;CreationDate=$script:created}
};
function Invoke-CimMethod {
  param($InputObject,$MethodName);
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  if($env:ORCA_UNINSTALL_CASE -eq 'foreign-owner'){$sid='foreign'};
  [pscustomobject]@{Sid=$sid}
};
function Get-Process {
  param($Id);
  $start=$script:created;
  if($env:ORCA_UNINSTALL_CASE -eq 'owned-submicrosecond'){$start=$start.AddTicks(1)};
  if($env:ORCA_UNINSTALL_CASE -eq 'reused-pid'){$start=$start.AddSeconds(1)};
  $p=[pscustomobject]@{Handle=1;Path=$script:root+'\\v1\\bun-runtime.exe';StartTime=$start};
  $p|Add-Member ScriptMethod Kill {[Console]::Out.WriteLine('KILLED_OWNED_FIXTURE')};
  $p|Add-Member ScriptMethod WaitForExit {param($milliseconds);return $true};
  $p|Add-Member ScriptMethod Dispose {};
  $p
};`

describe.runIf(process.platform === 'win32')(
  'Bun uninstall ownership under Windows PowerShell',
  () => {
    it.each([
      ['owned', 0, true],
      ['owned-submicrosecond', 0, true],
      ['unrelated', 0, false],
      ['foreign-owner', 1, false],
      ['reused-pid', 1, false],
      ['unknown-image', 1, false],
      ['query-failure', 1, false]
    ])('%s never kills an unproven owner', (scenario, code, kills) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')
      )
      const result = runProcessSync({
        program: join(
          process.env.SystemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        args: ['-NoProfile', '-NonInteractive', '-Command', syntheticProcesses + command],
        env: {
          ...env,
          LOCALAPPDATA: "C:\\Users\\O'Connor Test\\AppData\\Local",
          ORCA_UNINSTALL_CASE: scenario,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'Restricted'
        },
        timeoutMs: 15_000
      })
      expect(result.code, JSON.stringify(result)).toBe(code)
      expect(result.stdout.includes('KILLED_OWNED_FIXTURE')).toBe(kills)
    })
  }
)
