import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessCloseResult
} from './provider-process-close'
import type { ProviderCloseRequest } from './provider-process-supervisor'
import { terminateProviderProcessTree } from './provider-process-teardown'

type SupervisedChild = Pick<
  ChildProcessHandle,
  'pid' | 'kill' | 'stdin' | 'exitCode' | 'signalCode' | 'once'
>

/**
 * Closes a supervised child that is not a managed provider process: the shared close, with the
 * root-only policy, its tree forced (filed under `site`) only after the supervisor's full stop.
 */
export async function stopSupervisedChildProcess(
  child: SupervisedChild,
  {
    site,
    closeRequest = 'stdin-end-and-sigterm'
  }: { site: string; closeRequest?: ProviderCloseRequest }
): Promise<ProviderProcessCloseResult> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (exited()) {
    return { root: 'exited', tree: null }
  }
  return closeProviderProcess({
    child,
    exitPromise: new Promise<void>((resolve) => child.once('exit', () => resolve())),
    rootVerdict: () => (exited() ? 'exited' : 'live'),
    supervised: true,
    policy: {
      ...rootOnlyProviderClosePolicy(true),
      signalSupervisorOnClose: closeRequest === 'stdin-end-and-sigterm'
    },
    terminateTree: () => terminateProviderProcessTree(child, { site })
  })
}
