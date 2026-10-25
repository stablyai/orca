import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME
} from '../../../shared/orcad-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { ORCAD_MACHINE_HOMES_DIRNAME } from '../host-state/orcad-machine-home'

/** POSIX shell glob words for orcad's pinned Node runtimes; machine homes may hold other architectures, so callers must self-test each match. */
export function orcadPosixNodeRuntimeGlobs(): [string, string] {
  const store = `${RELAY_REMOTE_DIR}/${ORCAD_RUNTIMES_DIRNAME}/${ORCAD_NODE_RUNTIME_DIR_PREFIX}`
  const executable = `/${ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE}`
  const machineStores = `${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_HOMES_DIRNAME}/`
  return [
    `"$HOME"/${quotePosixShell(store)}*${quotePosixShell(executable)}`,
    `"$HOME"/${quotePosixShell(machineStores)}*/${quotePosixShell(store)}*${quotePosixShell(executable)}`
  ]
}
