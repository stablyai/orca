// A subscriber's status stream follows whichever installation Install acts on now.

import type { RpcContext } from '../../core'
import { ACP_HOST_BACKEND_SETTING_KEYS } from '../../../../acp/launch/acp-launch-contract'
import type { ManagedRuntimeInstallState } from '../../../../../shared/agent-launch/installation/managed-runtime-install'
import type { ManagedRuntimeInstallation } from '../../../../node-runtime/managed-runtime-installation'
import type { RevisionClock } from '../../../events/revisioned-state'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'

export type ManagedRuntimeInstallChoice = {
  /** The installation Install acts on now. */
  selected: () => Promise<ManagedRuntimeInstallation>
  /** Every installation `selected` may answer. */
  all: readonly ManagedRuntimeInstallation[]
  /** Their shared clock: a switch takes a fresh revision, which clients order after the last. */
  revisions: RevisionClock
  /** Tells when a fact the choice weighs changes apart from settings and these installations. */
  onChoiceChanged?: (listener: () => void) => () => void
}

const RUNNING_PHASES = new Set(['downloading', 'extracting', 'verifying', 'removing'])

export async function streamManagedRuntimeInstall(
  agent: string,
  ctx: RpcContext,
  emit: (state: ManagedRuntimeInstallState) => void,
  choice: ManagedRuntimeInstallChoice
): Promise<void> {
  let installation = await choice.selected()
  // A failed first read fails the subscribe; a later one keeps the client's last snapshot.
  const first = await installation.status()
  let shown = first.revision
  const frame = ctx.requestId ? `:${ctx.requestId}` : ''
  const subscriptionId = `managedRuntime:${ctx.connectionId ?? 'local'}:${agent}${frame}`
  let dispose = (): void => {}
  const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
  if (stream.isClosed()) {
    return
  }
  let reading = false
  let again = false
  // One read at a time; revisions during it coalesce into one more read.
  const follow = async (): Promise<void> => {
    again = true
    if (reading) {
      return
    }
    reading = true
    try {
      while (again && !stream.isClosed()) {
        again = false
        const shownState = await installation.status(false)
        // Progress keeps its own installation; the choice is read again only between operations.
        const running = shownState.operation && RUNNING_PHASES.has(shownState.operation.phase)
        const current = running ? installation : await choice.selected()
        const switched = current !== installation
        const next = switched ? await current.status(true) : shownState
        if ((switched || next.revision !== shown) && !stream.isClosed()) {
          installation = current
          shown = next.revision
          emit(switched ? { ...next, revision: choice.revisions.next() } : next)
        }
      }
    } catch (error) {
      console.warn(`[managed-runtime] ${agent} status not read for a subscriber:`, error)
    } finally {
      reading = false
    }
  }
  const stops = choice.all.map((each) => each.subscribe(() => void follow()))
  // The choice may follow a setting the host backend weighs, such as a chat's account type.
  const stopSettings =
    choice.all.length > 1
      ? ctx.runtime.requireStore().onSettingsChanged?.((updates) => {
          if (ACP_HOST_BACKEND_SETTING_KEYS.some((key) => key in updates)) {
            void follow()
          }
        })
      : undefined
  const stopChoice =
    choice.all.length > 1 ? choice.onChoiceChanged?.(() => void follow()) : undefined
  dispose = () => {
    stops.forEach((stop) => stop())
    stopSettings?.()
    stopChoice?.()
  }
  emit(first)
  // Catches a revision between the first read and the subscribe.
  void follow()
}
