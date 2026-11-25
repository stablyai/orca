import { basename } from 'node:path'
import { resolveOrchestrationCliExecutable } from '../orchestration/recovery/orchestration-recovery-command'

/** The launcher this CLI runs as, for the create command a refused adoption suggests; undefined for
 *  a shim whose name is no Orca launcher, leaving the runtime's default. */
export function adoptRecoveryCliCommand(): 'orca' | 'orca-dev' | 'orca-ide' | undefined {
  const name = basename(resolveOrchestrationCliExecutable())
  return name === 'orca' || name === 'orca-dev' || name === 'orca-ide' ? name : undefined
}
