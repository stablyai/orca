import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export const OPENCODE_RUNTIME_RESULT = 'ORCA_VAULT_SQLITE:'

function nodeCommand(
  host: RemoteHostPlatform,
  nodePath: string,
  script: string,
  args: string[]
): string {
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      `& ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(script)} -- ${args.map(powerShellNativeArg).join(' ')}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
    )
  }
  return `${shellEscape(nodePath)} -e ${shellEscape(script)} -- ${args.map(shellEscape).join(' ')}`
}

const SEND = `const send=(value)=>console.log(${JSON.stringify(OPENCODE_RUNTIME_RESULT)}+JSON.stringify(value));`
const HASH = `const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');
async function hash(file){try{const digest=require('node:crypto').createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex')}catch(error){if(error.code==='ENOENT')return null;throw error}}
`

export function probeOpenCodeNodeSqliteCommand(host: RemoteHostPlatform, nodePath: string): string {
  return nodeCommand(
    host,
    nodePath,
    `${SEND}
let db;try{db=new(require('node:sqlite').DatabaseSync)(':memory:');
if(db.prepare('SELECT 1 AS ready').get().ready!==1)throw Error('SQLite read failed');
send({status:'ready',executable:process.execPath})}catch{send({status:'unsupported'})}finally{if(db)db.close()}`,
    []
  )
}

export function prepareOpenCodeRuntimeStageCommand(args: {
  host: RemoteHostPlatform
  nodePath: string
  stageDir: string
  markerName: string
  executable?: string
  expectedHash?: string
  reference?: string
}): string {
  return nodeCommand(
    args.host,
    args.nodePath,
    `${HASH}${SEND}
(async()=>{const [stage,marker,executable,expected,reference]=process.argv.slice(1);
await fsp.mkdir(path.join(stage,'payload'),{recursive:true,mode:448});
await fsp.writeFile(path.join(stage,marker),'',{flag:'wx',mode:384});
let candidate=executable;let digest=candidate?await hash(candidate):null;
if(candidate&&digest!==expected){try{const ref=JSON.parse(await fsp.readFile(reference,'utf8'));
const relative=path.relative(path.dirname(executable),ref.executable);
if(ref.protocol===1&&relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)){candidate=ref.executable;digest=await hash(candidate)}}catch{}}
if(candidate&&digest===expected){if(process.platform!=='win32')await fsp.chmod(candidate,448);send({status:'ready',executable:candidate});return}
send({status:'staged'})})().catch(error=>{console.error(error.message);process.exitCode=1})`,
    [
      args.stageDir,
      args.markerName,
      args.executable ?? '',
      args.expectedHash ?? '',
      args.reference ?? ''
    ]
  )
}

export function promoteOpenCodeRuntimeCommand(args: {
  host: RemoteHostPlatform
  nodePath: string
  stagedBinary: string
  executable: string
  expectedHash: string
  repairToken: string
}): string {
  return nodeCommand(
    args.host,
    args.nodePath,
    `${HASH}${SEND}
(async()=>{const [source,destination,expected,token]=process.argv.slice(1);
if(await hash(source)!==expected)throw Error('Uploaded SQLite runtime checksum mismatch');
let executable=destination;const existing=await hash(destination);
if(existing!==expected){
if(existing!==null)executable=path.join(path.dirname(destination),'repair-'+token,path.basename(destination));
await fsp.mkdir(path.dirname(executable),{recursive:true,mode:448});
if(process.platform!=='win32')await fsp.chmod(source,448);
try{await fsp.link(source,executable)}catch(error){if(await hash(executable)!==expected)throw error}
}
send({status:'ready',executable})})().catch(error=>{console.error(error.message);process.exitCode=1})`,
    [args.stagedBinary, args.executable, args.expectedHash, args.repairToken]
  )
}

export function publishOpenCodeRuntimeReferenceCommand(args: {
  host: RemoteHostPlatform
  nodePath: string
  stagedReference: string
  reference: string
  token: string
}): string {
  return nodeCommand(
    args.host,
    args.nodePath,
    `${SEND}
const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{const [source,destination,token]=process.argv.slice(1);const temporary=destination+'.upload-'+token;
try{await fs.copyFile(source,temporary,require('node:fs').constants.COPYFILE_EXCL);
await fs.rename(temporary,destination);send({status:'published'})}
finally{await fs.rm(temporary,{force:true})}})().catch(error=>{console.error(error.message);process.exitCode=1})`,
    [args.stagedReference, args.reference, args.token]
  )
}

export function removeOpenCodeRuntimeStageCommand(
  host: RemoteHostPlatform,
  nodePath: string,
  stageDir: string
): string {
  return nodeCommand(
    host,
    nodePath,
    `require('node:fs/promises').rm(process.argv[1],{recursive:true,force:true}).catch(error=>{console.error(error.message);process.exitCode=1})`,
    [stageDir]
  )
}

export function parseOpenCodeRuntimeResult(output: string): {
  status: string
  executable?: string
} {
  const line = output.split(/\r?\n/).findLast((entry) => entry.startsWith(OPENCODE_RUNTIME_RESULT))
  if (!line) {
    throw new Error('The host did not confirm SQLite runtime setup.')
  }
  const result: unknown = JSON.parse(line.slice(OPENCODE_RUNTIME_RESULT.length))
  if (
    typeof result !== 'object' ||
    result === null ||
    !('status' in result) ||
    typeof result.status !== 'string'
  ) {
    throw new Error('Invalid SQLite runtime setup result.')
  }
  if ('executable' in result) {
    if (
      typeof result.executable !== 'string' ||
      !/^(?:\/|[A-Za-z]:[\\/])/.test(result.executable) ||
      /[\0\r\n]/.test(result.executable)
    ) {
      throw new Error('SQLite runtime setup returned an invalid executable path.')
    }
    return { status: result.status, executable: result.executable }
  }
  return { status: result.status }
}
