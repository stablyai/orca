import { getGeneratedNodeBoundedFileReaderSourceLines } from '../generated-node-bounded-file-reader'

export const WINDOWS_RELAY_LIVENESS_MAX_DIRECTORY_ENTRIES = 4_096
export const WINDOWS_RELAY_LIVENESS_MAX_PIPE_PATHS = 1_024
export const WINDOWS_RELAY_LIVENESS_DIRECTORY_BUFFER_SIZE = 32
export const WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE = 'INCONCLUSIVE'

type WindowsRelayLivenessProbeSourceOptions = {
  maxDirectoryEntries?: number
  maxPipePaths?: number
  directoryBufferSize?: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return resolved
}

export function getWindowsRelayLivenessProbeSource(
  options?: WindowsRelayLivenessProbeSourceOptions
): string {
  const maxDirectoryEntries = positiveInteger(
    options?.maxDirectoryEntries,
    WINDOWS_RELAY_LIVENESS_MAX_DIRECTORY_ENTRIES,
    'maxDirectoryEntries'
  )
  const maxPipePaths = positiveInteger(
    options?.maxPipePaths,
    WINDOWS_RELAY_LIVENESS_MAX_PIPE_PATHS,
    'maxPipePaths'
  )
  const directoryBufferSize = positiveInteger(
    options?.directoryBufferSize,
    WINDOWS_RELAY_LIVENESS_DIRECTORY_BUFFER_SIZE,
    'directoryBufferSize'
  )
  const boundedReadSource = getGeneratedNodeBoundedFileReaderSourceLines().join('')

  return [
    'const fs=require("fs"),path=require("path"),net=require("net");',
    boundedReadSource,
    'const [dir,...seed]=process.argv.slice(1);',
    'const valid=/^\\\\\\\\[.?]\\\\pipe\\\\orca-relay-[0-9a-f]{20}$/i;',
    `const maxEntries=${maxDirectoryEntries},maxPipes=${maxPipePaths};`,
    'const pipes=[],seen=new Set();',
    'let markerCount=0,capacityExceeded=false;',
    'function addPipe(p){',
    'if(!valid.test(p)||seen.has(p))return;',
    'if(pipes.length>=maxPipes){capacityExceeded=true;return}',
    'seen.add(p);pipes.push(p)',
    '}',
    'for(const p of seed){addPipe(p);if(capacityExceeded)break}',
    'let directory;',
    'if(!capacityExceeded)try{',
    `directory=fs.opendirSync(dir,{bufferSize:${directoryBufferSize}});`,
    'let entryCount=0;',
    'while(true){',
    'const entry=directory.readSync();',
    'if(!entry)break;',
    'if(entryCount>=maxEntries){capacityExceeded=true;break}',
    'entryCount++;',
    'const name=entry.name;',
    'if(!name.startsWith(".windows-active-pipe-"))continue;',
    'markerCount++;',
    'const p=readOrcaManagedFileWithinLimit(fs,path.join(dir,name)).trim();',
    'addPipe(p);',
    'if(capacityExceeded)break',
    '}',
    '}catch(error){if(error&&error.code==="EFBIG")capacityExceeded=true}',
    'finally{if(directory)try{directory.closeSync()}catch{}}',
    `if(capacityExceeded){process.stdout.write("${WINDOWS_RELAY_LIVENESS_INCONCLUSIVE_STATE}");process.exit(0)}`,
    'if(markerCount===0&&pipes.length===0){process.stdout.write("ALIVE");process.exit(0)}',
    'let i=0;',
    'function done(ok){process.stdout.write(ok?"ALIVE":"WAITING")}',
    'function next(){',
    'const pipe=pipes[i++];',
    'if(!pipe)return done(false);',
    'const s=net.connect(pipe);',
    'let settled=false;',
    'function finish(ok){if(settled)return;settled=true;s.destroy();if(ok)done(true);else next()}',
    's.setTimeout(200);',
    's.on("connect",()=>finish(true));',
    's.on("timeout",()=>finish(false));',
    's.on("error",()=>finish(false));',
    '}',
    'next();'
  ].join('')
}
