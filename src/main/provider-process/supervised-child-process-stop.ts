import type { Writable } from 'node:stream'
import type { EventEmitter } from 'node:events'
import type { ProviderChild } from './provider-child'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessCloseResult
} from './provider-process-close'
import type { ProviderCloseRequest } from './provider-process-supervisor'
import { terminateProviderProcessTree } from './provider-process-teardown'

type SupervisedChild = Pick<
  ProviderChild,
  'pid' | 'kill' | 'exitCode' | 'signalCode' | 'groupVerdict'
> &
  Pick<EventEmitter, 'once'> & { stdin?: Writable | null }

/** Allow the supervisor its full stop before forcing tree teardown for this root-only child. */
export async function stopSupervisedChildProcess(
  child: SupervisedChild,
  {
    site,
    closeRequest = 'stdin-end-and-sigterm'
  }: { site: string; closeRequest?: ProviderCloseRequest }
): Promise<ProviderProcessCloseResult> {
  let rootExited = false
  const exited = (): boolean =>
    rootExited ||
    child.groupVerdict === 'exited' ||
    child.exitCode !== null ||
    child.signalCode !== null
  if (exited()) {
    return { root: 'exited', tree: null }
  }
  return closeProviderProcess({
    child,
    exitPromise: new Promise<void>((resolve) =>
      child.once('exit', () => {
        rootExited = true
        resolve()
      })
    ),
    rootVerdict: () => (exited() ? 'exited' : 'live'),
    supervised: true,
    policy: {
      ...rootOnlyProviderClosePolicy(true),
      signalSupervisorOnClose: closeRequest === 'stdin-end-and-sigterm'
    },
    terminateTree: () => terminateProviderProcessTree(child, { site, supervised: true })
  })
}
