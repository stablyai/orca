// Sentinels skip noisy login profiles; base64 framing prevents PowerShell text decoding from corrupting bytes.
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME
} from '../../../shared/orcad-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { ORCAD_MACHINE_HOMES_DIRNAME } from '../host-state/orcad-machine-home'

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
  const store = `${RELAY_REMOTE_DIR}/${ORCAD_RUNTIMES_DIRNAME}/${ORCAD_NODE_RUNTIME_DIR_PREFIX}`
  const executable = `/${ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE}`
  const machineStores = `${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_HOMES_DIRNAME}/`
  return [
    `for runtime in "$HOME"/${quotePosixShell(store)}*${quotePosixShell(executable)}`,
    `"$HOME"/${quotePosixShell(machineStores)}*/${quotePosixShell(store)}*${quotePosixShell(executable)}; do`,
    `if [ -x "$runtime" ] && "$runtime" -e 0 >/dev/null 2>&1; then`,
    `exec "$runtime" -e ${quotePosixShell(script)} ${String(port)}; fi;`,
    `done; echo ${quotePosixShell(ORCAD_STDIO_BRIDGE_NO_NODE)}; exit 127`
  ].join(' ')
}
