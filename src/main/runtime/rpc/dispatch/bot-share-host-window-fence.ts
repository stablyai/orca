// A teammate's call never reaches the host's own window: nothing it opens, focuses or drives lands
// there. Every method a teammate can reach is classified once, in teammate-method-classes.json
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

const Params = z.looseObject({
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
  activate: z.boolean().optional(),
  focus: z.boolean().optional(),
  page: z.string().optional(),
  placement: z.looseObject({ kind: z.string() }).optional()
})
type HostWindowParams = z.infer<typeof Params>

/** A page the caller's own computer hosts: pageless commands fall back to the host's active tab. */
function ownClientPage(params: HostWindowParams, caller: HostWindowCaller): boolean {
  const page = params.page
    ? getRuntimeBrowserPageRegistry(caller.runtime).getPage(params.page)
    : null
  return page !== null && page !== undefined && page.pairedDeviceId === caller.pairedDeviceId
}

/** Each condition: true when these params stay off the host's window. */
export const HOST_WINDOW_CONDITIONS: Record<
  HostWindowCondition,
  (params: HostWindowParams, caller: HostWindowCaller) => boolean
> = {
  // Without a client kind the create activates on the host unless it names the caller.
  activatesOnlyForCaller: (params) => params.activate !== true || params.navigation === 'caller',
  // Omitted navigation publishes the reveal for every screen, the host's included.
  callerNavigation: (params) => params.navigation === 'caller',
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
