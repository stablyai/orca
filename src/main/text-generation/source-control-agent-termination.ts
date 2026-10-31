import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'
import { acceptProviderWriterClose } from '../provider-process/provider-process-close'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import type { SpawnedSourceControlAgentProcess } from './source-control-text-generation-types'

export const SOURCE_CONTROL_KILL_SITE = 'source-control-text-generation'

export async function killSourceControlAgentProcess(
  child: SpawnedSourceControlAgentProcess
): Promise<void> {
  if (child.supervised) {
    const result = await stopSupervisedChildProcess(child, { site: SOURCE_CONTROL_KILL_SITE })
    if (!acceptProviderWriterClose(result)) {
      throw new Error('Source control agent termination was not confirmed')
    }
    child.launchReport?.retire()
    return
  }
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    // Tree-walk refusal must not release the home lock having killed nothing; root handle kill cannot hit a recycled PID.
    await terminateWindowsProcessTree(pid, { site: SOURCE_CONTROL_KILL_SITE })
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The process may exit between the PID check and kill.
  }
}
