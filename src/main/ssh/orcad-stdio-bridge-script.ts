/**
 * The host side of the stdio tunnel to managed orcad: run on the host's pinned Node over one SSH
 * exec channel, it dials orcad's loopback port and pipes that socket to its own stdin/stdout.
 * Hosts whose sshd refuses port forwarding (`AllowTcpForwarding no`) still allow exec, which is
 * how every orcad host op already runs.
 *
 * A sentinel line comes first, so the client can skip whatever a login profile prints and tell a
 * running bridge from a host where it could not start. `base64` mode frames each chunk as one
 * ASCII line: a PowerShell DefaultShell re-decodes native output as text, which corrupts bytes.
 */
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME
} from '../../shared/orcad-artifacts'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_REMOTE_DIR } from './relay-protocol'

export type OrcadStdioBridgeMode = 'raw' | 'base64'

export const ORCAD_STDIO_BRIDGE_READY = 'ORCA-STDIO-BRIDGE READY'
/** The bridge ran but orcad's port refused it: a dead server, not a missing bridge. */
export const ORCAD_STDIO_BRIDGE_REFUSED = 'ORCA-STDIO-BRIDGE REFUSED'
/** No pinned Node in the host's runtime store. */
export const ORCAD_STDIO_BRIDGE_NO_NODE = 'ORCA-STDIO-BRIDGE NO_NODE'
/** Bounds a half-closed bridge whose orcad side never closes after the client's EOF. */
const HALF_CLOSE_GRACE_MS = 30_000

const text = JSON.stringify

/** `orcadStdioBridge(port, mode)`: shared by the POSIX `-e` script and the Windows host script. */
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

/** Any verified runtime in the store serves; orcad is running on one of them. */
export function orcadPosixStdioBridgeCommand(port: number): string {
  const script = `${ORCAD_STDIO_BRIDGE_FUNCTION}\norcadStdioBridge(Number(process.argv[1]), 'raw')`
  const runtimes = `"$HOME"/${shellEscape(`${RELAY_REMOTE_DIR}/${ORCAD_RUNTIMES_DIRNAME}`)}`
  return [
    `for runtime in ${runtimes}/${ORCAD_NODE_RUNTIME_DIR_PREFIX}*/${ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE}; do`,
    `if [ -x "$runtime" ]; then exec "$runtime" -e ${shellEscape(script)} ${String(port)}; fi;`,
    `done; echo ${shellEscape(ORCAD_STDIO_BRIDGE_NO_NODE)}; exit 127`
  ].join(' ')
}
