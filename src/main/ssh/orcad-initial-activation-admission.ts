import { ORCAD_LOCK_FILE_NAME } from '../orcad/orcad-instance-lock'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { PRIMARY_RUNTIME_METADATA_FILE } from '../../shared/runtime-bootstrap'
import { shellEscape } from './ssh-connection-utils'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

const OWNER_RECORD_MAX_BYTES = 64 * 1024

export type OrcadInitialActivationAdmission =
  | { decision: 'proceed' }
  | { decision: 'defer'; code: string; reason: string }

export function initialOrcadActivationAdmissionCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  remoteInstallDir: string
): string {
  const owners = [
    { name: ORCAD_LOCK_FILE_NAME, path: joinRemotePath(host, userDataDir, ORCAD_LOCK_FILE_NAME) },
    {
      name: PRIMARY_RUNTIME_METADATA_FILE,
      path: joinRemotePath(host, userDataDir, PRIMARY_RUNTIME_METADATA_FILE)
    }
  ]
  if (isWindowsRemoteHost(host)) {
    const records = owners
      .map(
        ({ name, path }) =>
          `[pscustomobject]@{ Name = ${powerShellLiteral(name)}; Path = ${powerShellLiteral(path)} }`
      )
      .join(', ')
    return powerShellCommand(
      [
        `$owners = @(${records})`,
        'foreach ($owner in $owners) {',
        'if (-not (Test-Path -LiteralPath $owner.Path)) { continue }',
        `if (-not (Test-Path -LiteralPath $owner.Path -PathType Leaf)) { Write-Output ('UNVERIFIABLE ' + $owner.Name); exit 0 }`,
        `if ((Get-Item -LiteralPath $owner.Path -Force).Length -gt ${OWNER_RECORD_MAX_BYTES}) { Write-Output ('UNVERIFIABLE ' + $owner.Name); exit 0 }`,
        "try { $record = [IO.File]::ReadAllText($owner.Path) | ConvertFrom-Json -ErrorAction Stop } catch { Write-Output ('UNVERIFIABLE ' + $owner.Name); exit 0 }",
        '[long]$ownerPid = 0',
        `if ($null -eq $record.pid -or -not [long]::TryParse([string]$record.pid, [ref]$ownerPid) -or $ownerPid -le 0) { Write-Output ('UNVERIFIABLE ' + $owner.Name); exit 0 }`,
        `if ($null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) { Write-Output ('LIVE ' + $owner.Name + ' ' + $ownerPid); exit 0 }`,
        '}',
        "Write-Output 'CLEAR'"
      ].join('; ')
    )
  }

  assertPosixOrcadHost(host)
  const runtime = joinRemotePath(host, remoteInstallDir, orcadBunRuntimeFilename(host.os))
  const script = [
    'const fs=require("node:fs");',
    `const limit=${OWNER_RECORD_MAX_BYTES};`,
    'const owners=JSON.parse(process.argv[1]??"[]");',
    'const invalid=(owner)=>`UNVERIFIABLE ${owner.name}`;',
    'function probe(owner){let fd;',
    'try{const noFollow=fs.constants.O_NOFOLLOW;',
    'if(typeof noFollow!=="number")return invalid(owner);',
    'fd=fs.openSync(owner.path,fs.constants.O_RDONLY|noFollow);',
    'const before=fs.fstatSync(fd);',
    'if(!before.isFile()||before.size>limit)return invalid(owner);',
    'const buffer=Buffer.alloc(limit+1);let bytes=0;',
    'while(bytes<buffer.length){const count=fs.readSync(fd,buffer,bytes,buffer.length-bytes,bytes);',
    'if(count===0)break;bytes+=count;}',
    'const after=fs.fstatSync(fd);',
    'if(bytes>limit||bytes!==after.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)',
    'return invalid(owner);',
    'const record=JSON.parse(buffer.subarray(0,bytes).toString("utf8"));',
    'const pid=record?.pid;',
    'if(!Number.isSafeInteger(pid)||pid<=0)return invalid(owner);',
    'try{process.kill(pid,0);return `LIVE ${owner.name} ${pid}`;}',
    'catch(error){if(error?.code==="ESRCH")return null;',
    'if(error?.code==="EPERM")return `LIVE ${owner.name} ${pid}`;',
    'return invalid(owner);}}',
    'catch(error){return error?.code==="ENOENT"?null:invalid(owner);}',
    'finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}}',
    'for(const owner of owners){const result=probe(owner);',
    'if(result){console.log(result);process.exit(0);}}console.log("CLEAR");'
  ].join('')
  return `${shellEscape(runtime)} -e ${shellEscape(script)} ${shellEscape(JSON.stringify(owners))}`
}

export function parseInitialOrcadActivationAdmission(
  output: string
): OrcadInitialActivationAdmission {
  const result = output.trim().split(/\r?\n/u).pop()?.trim() ?? ''
  if (result === 'CLEAR') {
    return { decision: 'proceed' }
  }
  const live = /^LIVE ([^ ]+) ([1-9][0-9]*)$/u.exec(result)
  if (live) {
    return {
      decision: 'defer',
      code: 'orcad_initial_runtime_live',
      reason:
        `An unmanaged runtime owner is still live according to ${live[1]} (pid ${live[2]}). ` +
        'Stop that Orca runtime before converting this data root to managed orcad.'
    }
  }
  const record = /^UNVERIFIABLE ([^ ]+)$/u.exec(result)?.[1] ?? 'owner record'
  return {
    decision: 'defer',
    code: 'orcad_initial_runtime_unverifiable',
    reason:
      `The host could not safely interpret ${record}, so it cannot prove the shared data root ` +
      'is quiescent. Preserve the file, verify its owner on the host, and retry after the owner exits.'
  }
}
