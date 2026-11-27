// A teammate's call never reaches the host's own window: nothing it opens, focuses or drives lands
// there, and no tab it opens is written into the host's tab list. Every method a teammate can reach is classified once, in teammate-method-classes.json
// (`hostWindow`); a method missing from it is refused.
import { z } from 'zod'
import {
  navigationTargetsHost,
  RUNTIME_NAVIGATION_TARGETS
} from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'
import classes from '../callers/teammate-method-classes.json'

export type HostWindowCondition = keyof typeof classes.hostWindow.conditional
export type HostWindowCaller = { runtime: OrcaRuntimeService; pairedDeviceId?: string }

// Each field on its own: a method whose key of the same name has another shape (agent.launch's
// `placement`) drops only that field, never the navigation or activation checks beside it.
const Params = z.looseObject({
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional().catch(undefined),
  activate: z.boolean().optional().catch(undefined),
  runHooks: z.boolean().optional().catch(undefined),
  focus: z.boolean().optional().catch(undefined),
  page: z.string().optional().catch(undefined),
  placement: z.looseObject({ kind: z.string() }).optional().catch(undefined)
})
type HostWindowParams = z.infer<typeof Params>

/** A page the caller's own computer hosts: pageless commands fall back to the host's active tab. */
function ownClientPage(params: HostWindowParams, caller: HostWindowCaller): boolean {
  const page = params.page
    ? getRuntimeBrowserPageRegistry(caller.runtime).getPage(params.page)
    : null
  return (
    caller.pairedDeviceId !== undefined &&
    page !== null &&
    page !== undefined &&
    page.pairedDeviceId === caller.pairedDeviceId
  )
}

/** Each condition: true when these params stay off the host's window. */
export const HOST_WINDOW_CONDITIONS: Record<
  HostWindowCondition,
  (params: HostWindowParams, caller: HostWindowCaller) => boolean
> = {
  // Without a client kind the create activates on the host unless it names the caller; running its
  // hooks activates it as `activate` does.
  activatesOnlyForCaller: (params) =>
    (params.activate !== true && params.runHooks !== true) || params.navigation === 'caller',
  // A host tab is on the host's window whether or not it is focused. A teammate's caller reveal opens
  // the chat in their own tabs and writes none of the host's (publishStructuredAgentSessionTab);
  // without it the reveal publishes to every screen, the host's included.
  writesNoHostTab: (params) => params.navigation === 'caller',
  clientPlacement: (params) => params.placement?.kind === 'client',
  ownClientPage,
  unfocusedOwnClientPage: (params, caller) => params.focus !== true && ownClientPage(params, caller)
}

const REFUSED = new Set(classes.hostWindow.refused)
const NONE = new Set(classes.hostWindow.none)
const isCondition = (name: string): name is HostWindowCondition => name in HOST_WINDOW_CONDITIONS
const CONDITION_OF = new Map(
  Object.entries(classes.hostWindow.conditional).flatMap(([condition, methods]) =>
    isCondition(condition) ? methods.map((method) => [method, condition] as const) : []
  )
)

export function reachesHostWindow(
  methodName: string,
  rawParams: unknown,
  caller: HostWindowCaller
): boolean {
  const params = Params.safeParse(rawParams).data ?? {}
  if (params.navigation && navigationTargetsHost(params.navigation)) {
    return true
  }
  if (NONE.has(methodName)) {
    return false
  }
  const condition = CONDITION_OF.get(methodName)
  // Refused, or not classified at all.
  return condition === undefined || REFUSED.has(methodName)
    ? true
    : !HOST_WINDOW_CONDITIONS[condition](params, caller)
}
