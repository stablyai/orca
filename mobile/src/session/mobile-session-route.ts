import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  HOST_SESSION_ROUTE,
  STANDALONE_SESSION_PARAM,
  type HostStackRouteTarget
} from '../navigation/host-stack-navigation'
import { nextPaneIntent, SESSION_PANE_INTENT_PARAM } from './session-pane-intent'

export type MobileSessionRouteParams = {
  hostId: string
  worktreeId: string
  paneKey?: string
  botItem?: string
  /** Added once to the bot's Home Chat draft, as its Ask in chat does. */
  homeDraft?: string
  goalHandoff?: string
  name?: string
  /** The server a `runtime:` workspace runs on; absent for the desktop's own workspaces. */
  executionHost?: ExecutionHostId
  /** Opens in place of the host's list, so Back returns to the opener. */
  standalone?: boolean
}

// Leave identities raw because the navigator owns parameter encoding.
export function mobileSessionRouteTarget({
  hostId,
  worktreeId,
  name,
  paneKey,
  botItem,
  homeDraft,
  goalHandoff,
  executionHost,
  standalone
}: MobileSessionRouteParams): HostStackRouteTarget {
  return {
    name: HOST_SESSION_ROUTE,
    params: {
      hostId,
      worktreeId,
      ...(name ? { name } : {}),
      ...(paneKey ? { paneKey, [SESSION_PANE_INTENT_PARAM]: nextPaneIntent() } : {}),
      ...(goalHandoff ? { goalHandoff } : {}),
      ...(botItem ? { botItem } : {}),
      ...(homeDraft ? { homeDraft } : {}),
      ...(executionHost ? { executionHost } : {}),
      ...(standalone ? { [STANDALONE_SESSION_PARAM]: '1' } : {})
    }
  }
}
