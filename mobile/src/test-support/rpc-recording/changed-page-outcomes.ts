import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-item-target'
import { GITHUB_CONNECTION_CHANGED } from '../../transport/github-target-invocation'
import { isKeyedObject, scriptsAbsentResultReply } from '../bridged-parity/divergence-evidence'
import { rows } from './changed-bridge-outcomes'
import { ITEM_REFUSALS } from './changed-page-item-refusals'
import {
  BRIDGE_REPLY_REFUSED,
  READ_AND_PROJECT_REFUSALS,
  Retained,
  type PageEnding
} from './changed-page-refusals'
import type { Observation, Recording, RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

const PAGE_REFUSALS = { ...READ_AND_PROJECT_REFUSALS, ...ITEM_REFUSALS }
export const PAGE_REFUSAL_PRODUCERS = Object.keys(PAGE_REFUSALS)

// The error each side shows for the refused request. The GitHub exact-target check maps its own failures:
// natively an unreadable answer says to update the server, while the page's refusal of that frame is a failed
// transport check, which says the connection changed.
function copies(request: string): readonly [native: string, page: string] {
  const method = request.replace(/#.*$/, '')
  return method === 'status.get'
    ? [GITHUB_EXACT_OPERATION_UNSUPPORTED, GITHUB_CONNECTION_CHANGED]
    : [`The host sent a reply this app could not read (${method})`, BRIDGE_REPLY_REFUSED]
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

function acceptsAbsentResult(attempt: Record<string, RecordedValue>): boolean {
  const settlement = attempt.settlement
  return (
    isKeyedObject(settlement) &&
    settlement.status === 'fulfilled' &&
    isKeyedObject(settlement.value) &&
    settlement.value.ok === true &&
    !Object.hasOwn(settlement.value, 'result')
  )
}

// Replace one named slot after checking it holds the reviewed native value, so a stale case fails.
function edit(
  observation: Observation,
  path: string,
  native: RecordedValue,
  page: RecordedValue
): void {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  const last = keys.pop()!
  let container: unknown = observation
  for (const key of keys) {
    container = Array.isArray(container)
      ? container[Number(key)]
      : isKeyedObject(container)
        ? container[key]
        : undefined
  }
  const stale = () =>
    new Error(`Reviewed native slot ${path} no longer holds ${JSON.stringify(native)}`)
  if (Array.isArray(container)) {
    if (!same(container[Number(last)], native)) {
      throw stale()
    }
    container[Number(last)] = page
  } else if (isKeyedObject(container) && same(container[last], native)) {
    container[last] = page
  } else {
    throw stale()
  }
}

function end(observation: Observation, ending: PageEnding): void {
  for (const [key, [native, page]] of Object.entries(ending.state)) {
    edit(observation, `state.${key}`, native, page)
  }
  const [native, page] = ending.effects
  const effects = rows(observation.effects)
  const tail = effects.slice(-native.length)
  const shown = (value: RecordedValue | Retained) =>
    value instanceof Retained
      ? isKeyedObject(observation.state)
        ? observation.state[value.key]
        : undefined
      : value
  if (
    tail.length !== native.length ||
    page.length > native.length ||
    native.some(([name, value], index) => {
      const effect = tail[index]!
      return effect.name !== name || !same(effect.value, shown(value))
    })
  ) {
    throw new Error(
      `Reviewed native golden no longer ends with ${native.map(([name]) => name).join(', ')}`
    )
  }
  observation.effects = [
    ...effects.slice(0, -native.length),
    ...page.map(([name, value], index) => ({ name, ordinal: tail[index]!.ordinal, value }))
  ]
}

/**
 * The expected page recording of a changed producer, built from its reviewed native golden and declared
 * page refusals alone, before any page run is judged. Both page modes refuse the injected absent result
 * alike (reply metadata adds no result), so one expectation serves each. Every other field stays native.
 */
export function pageExpectation(
  id: string,
  expected: Recording,
  scenarios: readonly RecordingScenario[]
): Recording {
  const refusal = PAGE_REFUSALS[id]
  const declared = new Set(Object.keys(refusal?.checkpoints ?? {}))
  const checkpoints = expected.checkpoints.map((checkpoint) => {
    const absent = rows(checkpoint.observation.sender).filter(acceptsAbsentResult)
    if (!absent.length && !declared.has(checkpoint.id)) {
      return checkpoint
    }
    const slots = refusal?.checkpoints[checkpoint.id]
    const source =
      scenarios.length === 1
        ? scenarios[0]
        : scenarios.find((scenario) => checkpoint.id.startsWith(`${scenario.id}:`))
    if (
      !refusal ||
      !slots ||
      !source ||
      !scriptsAbsentResultReply(source) ||
      absent.length !== 1 ||
      absent[0]!.name !== refusal.request
    ) {
      throw new Error(`Undeclared or stale page refusal: ${id} ${checkpoint.id}`)
    }
    declared.delete(checkpoint.id)
    const observation: Observation = structuredClone(checkpoint.observation)
    const attempt = rows(observation.sender).find((entry) => entry.name === refusal.request)!
    const settlement = attempt.settlement
    if (!isKeyedObject(settlement)) {
      throw new Error(`Missing reviewed settlement: ${refusal.request}`)
    }
    const { value: _value, ...timing } = settlement
    attempt.settlement = {
      ...timing,
      status: 'rejected',
      error: {
        category: 'BridgeReplyRefusedError',
        message: BRIDGE_REPLY_REFUSED,
        isRpcDeliveryUnknown: true
      }
    }
    if ('effects' in slots) {
      end(observation, slots)
    } else {
      const [native, page] = copies(refusal.request)
      for (const slot of slots) {
        edit(observation, slot, native, page)
      }
    }
    return { ...checkpoint, observation }
  })
  if (declared.size) {
    throw new Error(
      `Declared page refusal has no reviewed checkpoint: ${id} ${[...declared].join(', ')}`
    )
  }
  return { ...expected, checkpoints }
}
