// Sentinels skip noisy login profiles; base64 framing prevents PowerShell text decoding from corrupting bytes.
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { orcadPosixNodeRuntimeGlobs } from '../install/orcad-node-runtime-globs'

export type OrcadStdioBridgeMode = 'raw' | 'base64'

export const ORCAD_STDIO_BRIDGE_READY = 'ORCA-STDIO-BRIDGE READY'
// Refused server ports do not mean the bridge runtime is missing.
export const ORCAD_STDIO_BRIDGE_REFUSED = 'ORCA-STDIO-BRIDGE REFUSED'
export const ORCAD_STDIO_BRIDGE_NO_NODE = 'ORCA-STDIO-BRIDGE NO_NODE'
const HALF_CLOSE_GRACE_MS = 30_000

const text = JSON.stringify

// POSIX inline execution and the Windows host script must share the same bridge function.
export const ORCAD_STDIO_BRIDGE_FUNCTION = `function orcadStdioBridge(port, mode) {
  const net = require('net')
  const out = process.stdout
  const exit = () => out.write('', () => process.exit(0))
  out.on('error', () => process.exit(0))
  let connected = false
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.on('error', (error) => {
    if (!connected) out.write(${text(`${ORCAD_STDIO_BRIDGE_REFUSED} `)} + String(error.code || 'ERROR') + '\\n', () => process.exit(0))
  })
  socket.on('close', () => { if (connected) exit() })
  socket.on('connect', () => {
    connected = true
    out.write(${text(`${ORCAD_STDIO_BRIDGE_READY}\n`)})
    const input = process.stdin
    input.on('end', () => {
      socket.end()
      setTimeout(() => socket.destroy(), ${HALF_CLOSE_GRACE_MS}).unref()
    })
    if (mode !== 'base64') {
      input.pipe(socket, { end: false })
      socket.pipe(out, { end: false })
      return
    }
    let pending = ''
    input.setEncoding('latin1')
    input.on('data', (chunk) => {
      const lines = (pending + chunk).split('\\n')
      pending = lines.pop()
      for (const line of lines) {
        const encoded = line.trim()
        if (encoded && !socket.write(Buffer.from(encoded, 'base64'))) {
          input.pause()
          socket.once('drain', () => input.resume())
        }
      }
    })
    socket.on('data', (chunk) => {
      if (!out.write(chunk.toString('base64') + '\\n')) {
        socket.pause()
        out.once('drain', () => socket.resume())
      }
    })
  })
}`

/** Shared machine homes may contain other architectures' runtimes; self-test before exec. */
export function orcadPosixStdioBridgeCommand(port: number): string {
  const script = `${ORCAD_STDIO_BRIDGE_FUNCTION}\norcadStdioBridge(Number(process.argv[1]), 'raw')`
  const [runtimeStore, machineRuntimeStores] = orcadPosixNodeRuntimeGlobs()
  return [
    `for runtime in ${runtimeStore}`,
    `${machineRuntimeStores}; do`,
    `if [ -x "$runtime" ] && "$runtime" -e 0 >/dev/null 2>&1; then`,
    `exec "$runtime" -e ${quotePosixShell(script)} ${String(port)}; fi;`,
    `done; echo ${quotePosixShell(ORCAD_STDIO_BRIDGE_NO_NODE)}; exit 127`
  ].join(' ')
}

/**
 * A bash /dev/tcp relay costs ~5 MB of RSS where a Node bridge costs ~50 MB. Closing either side
 * ends both: Node's half-close grace bought nothing, since the desktop socket never reads after
 * its own FIN. Bash older than 4.3 (no `wait -n`), or one built without /dev/tcp, and refused
 * dials fall through to the Node bridge, which reports the refusal sentinel.
 */
export function orcadBashStdioBridgeCommand(port: number): string {
  const relay = [
    // POSIXLY_CORRECT would make a failed `exec` redirection exit the shell before the fallback.
    'set +o posix;',
    'if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3))) &&',
    `{ exec 3<>/dev/tcp/127.0.0.1/${String(port)}; } 2>/dev/null; then`,
    // Background jobs read /dev/null unless stdin is redirected explicitly.
    'exec 4<&0;',
    `echo ${quotePosixShell(ORCAD_STDIO_BRIDGE_READY)};`,
    'cat <&3 & r=$!;',
    'cat <&4 >&3 & w=$!;',
    'exec 4<&-;',
    // Reap the cat just killed: WSL's session init never does, and its zombie keeps the distro up.
    'wait -n; kill $r $w 2>/dev/null; wait; exit 0; fi;',
    'eval "$1"'
  ].join(' ')
  // Carry the Node bridge once, as data both shells can run.
  return [
    `orca_node_bridge=${quotePosixShell(orcadPosixStdioBridgeCommand(port))};`,
    'if command -v bash >/dev/null 2>&1; then unset BASH_ENV;',
    `exec bash -c ${quotePosixShell(relay)} orca-stdio-bridge "$orca_node_bridge"; fi;`,
    'eval "$orca_node_bridge"'
  ].join(' ')
}
