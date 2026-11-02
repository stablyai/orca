import type { ChildProcessHandle } from '@orca/process-host/process-spec'
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

/** Allow the supervisor its full stop before forcing tree teardown for this root-only child. */
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
    terminateTree: () => terminateProviderProcessTree(child, { site, supervised: true })
  })
}
