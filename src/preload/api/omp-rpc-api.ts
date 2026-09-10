import type {
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'

export type OmpRpcApi = {
  /** Live slash-command catalog from a session-less OMP probe for `cwd`.
   *  Fail-closed: the composer falls back to its static catalog on `ok:false`. */
  getCommands: (args: { cwd: string }) => Promise<OmpRpcGetCommandsResult>
  /** Run an allowlisted local command (milestone 1: `/usage`) on the probe.
   *  `agentInvoked:false` means no model turn happened, so the caller must not
   *  render an assistant message. */
  runLocalCommand: (args: { cwd: string; command: string }) => Promise<OmpRpcRunLocalCommandResult>
}
