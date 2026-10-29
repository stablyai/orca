/** Map machine-wide relay pipes to this account's version-directory credentials/markers. Deriving pipe names from this desktop's target id misses other desktops' relays. */
import { RELAY_REMOTE_DIR } from '../remote-exec/remote-frame-protocol'
import { commandWithNodePath } from '../ssh-remote-commands'
import {
  quotePowerShellLiteral as powerShellLiteral,
  quotePowerShellNativeArgument as powerShellNativeArg
} from '../../../shared/powershell-native-argument'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import {
  RELAY_INSTALL_MODEL,
  remoteInstallVersionDirRegex
} from '../../managed-server/install/remote-install-model'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh-remote-platform'

type WindowsRelayPipeOwner = { dir: string; credentialFile: string }

type WindowsRelayInventory = {
  pipes: string[]
  /** Pipes this account's version directories account for, keyed by lower-cased path. */
  owners: Map<string, WindowsRelayPipeOwner>
}

const MARKER_PREFIX = '.windows-active-pipe-'
const CREDENTIAL_SUFFIX = '.credential'

// Use ES5/stdout JSON for whichever Node the host provides.
export const WINDOWS_RELAY_INVENTORY_JS = [
  'var fs=require("fs"),path=require("path");var base=process.argv[1];',
  'var out={pipes:null,dirs:null};',
  'try{out.pipes=fs.readdirSync("\\\\\\\\.\\\\pipe\\\\").filter(function(n){',
  'return /^orca-relay-[0-9a-f]{20}$/i.test(n)})}catch(e){}',
  'try{out.dirs={};fs.readdirSync(base).forEach(function(d){if(!/^relay-/.test(d))return;',
  'var entry={credentials:[],markers:{}};try{fs.readdirSync(path.join(base,d)).forEach(function(f){',
  `if(f.slice(-${CREDENTIAL_SUFFIX.length})===${JSON.stringify(CREDENTIAL_SUFFIX)})entry.credentials.push(f);`,
  `else if(f.indexOf(${JSON.stringify(MARKER_PREFIX)})===0){`,
  'try{entry.markers[f]=fs.readFileSync(path.join(base,d,f),"utf8").trim()}catch(e){entry.markers[f]=null}}',
  '})}catch(e){entry=null}out.dirs[d]=entry})}catch(e){if(e.code!=="ENOENT")out.dirs=null}',
  'process.stdout.write(JSON.stringify(out))'
].join('')

export function windowsRelayInventoryCommand(
  host: RemoteHostPlatform,
  nodePath: string,
  remoteHome: string
): string {
  const baseDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
  return commandWithNodePath(
    host,
    nodePath,
    remoteHome,
    // Encode native arguments because PowerShell strips the script's inner quotes.
    `& ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(WINDOWS_RELAY_INVENTORY_JS)} ${powerShellNativeArg(baseDir)}`
  )
}

function isDirEntry(entry: unknown): entry is { credentials: unknown[]; markers: object } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'credentials' in entry &&
    Array.isArray(entry.credentials) &&
    'markers' in entry &&
    typeof entry.markers === 'object' &&
    entry.markers !== null
  )
}

/** Null on any unreadable pipe/version listing: unknown relay instances cannot prove absence. */
export function parseWindowsRelayInventory(
  host: RemoteHostPlatform,
  remoteHome: string,
  extraSockNames: readonly string[],
  output: string
): WindowsRelayInventory | null {
  let raw: { pipes?: unknown; dirs?: unknown }
  try {
    raw = JSON.parse(output.trim().split('\n').pop() ?? '')
  } catch {
    return null
  }
  if (!Array.isArray(raw.pipes) || !raw.dirs || typeof raw.dirs !== 'object') {
    return null
  }
  const pipes = raw.pipes
    .filter((name): name is string => typeof name === 'string')
    .map((name) => `\\\\.\\pipe\\${name}`)
  const owners = new Map<string, WindowsRelayPipeOwner>()
  const baseDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
  const versionDir = remoteInstallVersionDirRegex(RELAY_INSTALL_MODEL)
  for (const [name, entry] of Object.entries(raw.dirs)) {
    if (!versionDir.test(name)) {
      continue
    }
    if (!isDirEntry(entry)) {
      return null
    }
    const dir = joinRemotePath(host, baseDir, name)
    const own = (pipe: string, sockName: string): void => {
      owners.set(pipe.toLowerCase(), {
        dir,
        credentialFile: joinRemotePath(host, dir, `${sockName}${CREDENTIAL_SUFFIX}`)
      })
    }
    const sockNames = new Set(extraSockNames)
    for (const file of entry.credentials) {
      if (typeof file === 'string' && file.endsWith(CREDENTIAL_SUFFIX)) {
        sockNames.add(file.slice(0, -CREDENTIAL_SUFFIX.length))
      }
    }
    for (const sockName of sockNames) {
      for (const pipe of windowsRelayPipePathsForSocketName(host, dir, sockName)) {
        own(pipe, sockName)
      }
    }
    for (const [marker, pipe] of Object.entries(entry.markers)) {
      // The marker name is the socket name with only [A-Za-z0-9.-] kept, which relay names are.
      if (typeof pipe === 'string' && marker.startsWith(MARKER_PREFIX)) {
        own(pipe, marker.slice(MARKER_PREFIX.length))
      }
    }
  }
  return { pipes, owners }
}

// Only EACCES/EPERM proves foreign ownership and ENOENT proves disappearance; all other pipe failures stay unknown.
export const WINDOWS_PIPE_ACCESS_JS = [
  'var net=require("net");var pipes=process.argv.slice(1);var out={};var i=0;',
  'function next(){if(i>=pipes.length){process.stdout.write(JSON.stringify(out));return}',
  'var p=pipes[i++];var s=net.connect(p);var done=false;',
  'function fin(v){if(done)return;done=true;clearTimeout(timer);out[p]=v;try{s.destroy()}catch(e){}next()}',
  's.on("connect",function(){fin("ok")});s.on("error",function(e){fin(e.code||"unknown")});',
  'var timer=setTimeout(function(){fin("timeout")},2000)}next()'
].join('')

export function windowsPipeAccessCommand(
  host: RemoteHostPlatform,
  nodePath: string,
  remoteHome: string,
  pipes: readonly string[]
): string {
  return commandWithNodePath(
    host,
    nodePath,
    remoteHome,
    [
      `& ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(WINDOWS_PIPE_ACCESS_JS)}`,
      ...pipes.map((pipe) => powerShellNativeArg(pipe))
    ].join(' ')
  )
}

/** Pipes provably another account's, or gone; every other pipe stays this account's question. */
export function windowsPipesNotRunHere(output: string): Set<string> {
  const notRunHere = new Set<string>()
  try {
    const parsed: unknown = JSON.parse(output.trim().split('\n').pop() ?? '')
    if (parsed && typeof parsed === 'object') {
      for (const [pipe, code] of Object.entries(parsed)) {
        if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
          notRunHere.add(pipe.toLowerCase())
        }
      }
    }
  } catch {
    // Unreadable answers prove nothing foreign.
  }
  return notRunHere
}
