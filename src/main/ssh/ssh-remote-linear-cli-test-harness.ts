import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  runRemoteOrcaCli as runRemoteOrcaCliWithHostPassthrough,
  type RemoteOrcaCliRequest
} from './ssh-remote-orca-cli'

const LEGACY_FALLBACK_OPTIONS = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => false
}

export function runRemoteOrcaCli(runtime: OrcaRuntimeService, request: RemoteOrcaCliRequest) {
  return runRemoteOrcaCliWithHostPassthrough(runtime, request, LEGACY_FALLBACK_OPTIONS)
}
