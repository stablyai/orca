/**
 * Before the first managed activation, prove no unmanaged Orca runtime owns the data root.
 *
 * With no active record there is no incumbent to stop, but a hand-started orcad or headless
 * Orca may still hold the shared root. Its owner records name a PID; a live, unreadable or
 * unexpected record defers rather than starting a second owner beside it.
 */
import { ORCAD_LOCK_FILE_NAME } from '../orcad/orcad-instance-lock'
import { PRIMARY_RUNTIME_METADATA_FILE } from '../../shared/runtime-bootstrap'
import { shellEscape } from './ssh-connection-utils'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { orcadWindowsBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'

const OWNER_RECORD_MAX_BYTES = 64 * 1024

export type OrcadInitialActivationAdmission =
  | { decision: 'proceed' }
  | { decision: 'defer'; code: string; reason: string }

/** Runs on the candidate slot's own runtime, so the probe needs no host Node. */
export function initialOrcadActivationAdmissionCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  remoteInstallDir: string,
  legacyNodePath: string
): string {
  if (isWindowsRemoteHost(host)) {
    // Windows has no O_NOFOLLOW; the host script refuses links by lstat instead.
    return orcadWindowsHostOpCommand(
      host,
      orcadWindowsBaseDir(host, remoteInstallDir),
      'owner-admission',
      [userDataDir]
    )
  }
  const owners = [ORCAD_LOCK_FILE_NAME, PRIMARY_RUNTIME_METADATA_FILE].map((name) => ({
    name,
    path: joinRemotePath(host, userDataDir, name)
  }))
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
  // The subshell turns the selector's `exit 78` into silence, which parses as unverifiable.
  return (
    `(${selectOrcadSlotRuntimeCommand(host, remoteInstallDir, legacyNodePath)}; ` +
    `"$orcad_runtime" -e ${shellEscape(script)} ${shellEscape(JSON.stringify(owners))})`
  )
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
