import { expect } from 'vitest'
import { isKeyedObject } from '../bridged-parity/divergence-evidence'
import type { AttemptObservation } from './recording-causality'
import type { Observation, Recording, RecordingScenario } from './recording-scenario'
import { captureArguments, captureValue, type RecordedValue } from './recording-values'
import { materializeScenario } from './scenario-execution-mode'
import { rows } from './changed-bridge-outcomes'

// The probe-aware comparison view: declared probes verified then projected, protocol IDs translated only in
// bound slots, and retained TEST ordinals re-ranked only after a verified projection.

export function attempts(observation: Observation): AttemptObservation[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner clones the transport attempt array at this exact Recording boundary.
  return observation.sender as unknown as AttemptObservation[]
}

// Only known protocol response slots are translated. Result/user objects are never traversed.
export function response(
  value: RecordedValue,
  original: RecordedValue,
  ids: ReadonlyMap<string, string>,
  replyMeta: boolean
): RecordedValue {
  if (!isKeyedObject(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
    return value
  }
  const id = ids.get(value.id)
  if (!id) {
    throw new Error('Reply has no actual physical binding')
  }
  const translated: Record<string, RecordedValue> = { ...value, id }
  if (
    replyMeta &&
    isKeyedObject(original) &&
    !Object.hasOwn(original, '_meta') &&
    Object.hasOwn(translated, '_meta')
  ) {
    expect(translated._meta).toEqual({ runtimeId: 'counterfactual-runtime' })
    delete translated._meta
  }
  return translated
}

export function comparison(
  input: readonly RecordingScenario[],
  expected: Recording,
  raw: Recording,
  scenarios: readonly RecordingScenario[],
  replyMeta: boolean
): { expected: Recording; actual: Recording } {
  expect(raw.scenario).toBe(expected.scenario)
  expect(raw.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(
    expected.checkpoints.map((checkpoint) => checkpoint.id)
  )
  const project = (before: Observation, after: Observation, checkpoint: string) => {
    const sources =
      scenarios.length === 1
        ? [...scenarios]
        : scenarios.filter(
            (scenario) =>
              scenario.steps.some(
                (step) => 'checkpoint' in step && `${scenario.id}:${step.checkpoint}` === checkpoint
              ) || `${scenario.id}:cleanup` === checkpoint
          )
    if (sources.length !== 1) {
      throw new Error('Missing or crossed checkpoint input occurrence')
    }
    const source = sources[0]!
    const base = input.find((candidate) => candidate.id === source.lineage?.baseScenario)
    if (!base) {
      throw new Error('Missing actual base input for probe declarations')
    }
    const declarations = (source.bridgeOperations ?? []).map((operation) => {
      const step =
        source.steps.find(
          (step) => step.bridgeSite && 'complete' in step && step.complete === operation.probeSite
        ) ??
        materializeScenario(base, 'bridge').steps.find(
          (step) => step.bridgeSite && 'complete' in step && step.complete === operation.probeSite
        )
      if (!step) {
        throw new Error('Operation has no source-declared probe')
      }
      return step
    })
    const probeNames = new Set(
      declarations.map((step) => {
        if (!('complete' in step)) {
          throw new Error('Declared probe is not a completion')
        }
        return step.complete
      })
    )
    if (probeNames.size !== declarations.length) {
      throw new Error('Duplicate declared probe')
    }
    const nativePayloads = rows(before.payloads)
    const rawPayloads = rows(after.payloads)
    const names = new Map<string, string>()
    const probeIds = new Set<string>()
    for (const sender of attempts(after)) {
      const posts = sender.bridge?.posts
      if (!posts) {
        throw new Error('Missing actual page invocation')
      }
      if (posts.length === 0) {
        expect(nativePayloads.filter((row) => row.name === sender.name)).toEqual([])
        expect(sender.settlement.status).toBe('rejected')
        expect(sender.bridge!.page!.afterArgs).toEqual(sender.args)
        continue
      }
      if (posts.length !== 1) {
        throw new Error('Duplicate actual page request')
      }
      const post = posts[0]!
      const posted: unknown = JSON.parse(post.json)
      if (
        !isKeyedObject(posted) ||
        posted.type !== 'request' ||
        posted.id !== post.id ||
        post.parent !== sender.name
      ) {
        throw new Error('Crossed actual page request')
      }
      const declared = post.children.filter((child) => probeNames.has(child.name))
      const children = post.children.filter((child) => !probeNames.has(child.name))
      const expectedOperation = sources[0]!.bridgeOperations?.find(
        (entry) => entry.request === sender.name
      )
      expect(declared).toHaveLength(expectedOperation ? 1 : 0)
      if (expectedOperation) {
        expect(post.children.map((child) => child.method)).toEqual(
          expectedOperation.methods.slice(0, post.children.length)
        )
      }
      for (const probe of declared) {
        const declaration = declarations.find(
          (step) => 'complete' in step && step.complete === probe.name
        )
        if (
          !declaration ||
          !('complete' in declaration) ||
          declaration.reject ||
          !probe.frame ||
          probe.method !== 'status.get'
        ) {
          throw new Error('Unexpected bridge-only probe')
        }
        expect(probe.args).toEqual(
          captureArguments([
            'status.get',
            undefined,
            {
              timeoutMs: 30_000,
              ...(isKeyedObject(posted.options) ? posted.options : {}),
              beforeSend: () => {}
            }
          ])
        )
        if (probe.completion) {
          expect(probe.completion.reply).toEqual(captureValue(declaration.reply))
          expect(probe.settlement.status).toBe('fulfilled')
        } else if (checkpoint === 'cleanup' || checkpoint === `${source.id}:cleanup`) {
          expect(probe.settlement).toMatchObject({
            status: 'rejected',
            error: { message: 'Connection closed', isRpcDeliveryUnknown: true }
          })
          expect(sender.settlement).toMatchObject({
            status: 'rejected',
            error: { category: 'BridgeClientClosedError', message: 'the page bridge was closed' }
          })
        } else {
          expect(probe.settlement.status).toBe('pending')
        }
        const payload = rawPayloads.find((row) => row.name === probe.name)
        if (!payload || typeof payload.json !== 'string') {
          throw new Error('Probe has no actual bytes')
        }
        expect(JSON.parse(payload.json)).toEqual({
          id: probe.frame.id,
          deviceToken: 'recording-device',
          method: 'status.get'
        })
        probeIds.add(probe.frame.id)
      }
      if (!children.length && declared.length === 1 && !declared[0]!.completion) {
        continue
      }
      if (children.length !== 1) {
        throw new Error('Actual operation did not forward exactly once')
      }
      const child = children[0]!
      if (
        (child.frame || child.allocation) &&
        (!child.frame || !child.allocation || child.frame.id !== child.allocation.id)
      ) {
        throw new Error('Missing actual operation allocation/frame')
      }
      expect(child.method).toBe(posted.method)
      if (declared.length) {
        expect(declared).toHaveLength(1)
        expect(declared[0]!.completion!.ordinal).toBeLessThan(child.ordinal)
      }
      names.set(child.name, sender.name)
    }
    const kept = rawPayloads.filter((row) => {
      if (typeof row.json !== 'string') {
        throw new Error('Missing raw bytes')
      }
      return !probeIds.has(JSON.parse(row.json).id)
    })
    expect(kept).toHaveLength(nativePayloads.length)
    const ids = new Map<string, string>()
    for (const [index, row] of kept.entries()) {
      const native = nativePayloads[index]!
      if (typeof row.json !== 'string' || typeof native.json !== 'string') {
        throw new Error('Missing request bytes')
      }
      const frame = JSON.parse(row.json),
        original = JSON.parse(native.json)
      expect(names.get(String(row.name)) ?? row.name).toBe(native.name)
      expect({ ...frame, id: original.id }).toEqual(original)
      if (ids.has(frame.id) || [...ids.values()].includes(original.id)) {
        throw new Error('Non-bijective protocol IDs')
      }
      ids.set(frame.id, original.id)
    }
    const sender: RecordedValue[] = attempts(after).map((attempt, index) => {
      const original = attempts(before)[index]
      if (!original || original.name !== attempt.name) {
        throw new Error('Changed actual caller sequence')
      }
      const { bridge: _bridge, ...value } = attempt
      if (value.settlement.status === 'fulfilled') {
        value.settlement = {
          ...value.settlement,
          value: response(
            value.settlement.value,
            original.settlement.status === 'fulfilled' ? original.settlement.value : null,
            ids,
            replyMeta
          )
        }
      }
      return value
    })
    const actual: Observation = {
      ...after,
      sender,
      payloads: kept.map((row) => ({
        ...row,
        name: names.get(String(row.name)) ?? row.name,
        json: JSON.stringify({
          ...JSON.parse(String(row.json)),
          id: ids.get(JSON.parse(String(row.json)).id)
        })
      }))
    }
    const rank = (observation: Observation): Observation => {
      const events = [
        ...rows(observation.sender),
        ...rows(observation.payloads),
        ...rows(observation.effects)
      ]
      const ordinals = events.map((entry) => entry.ordinal)
      if (
        !ordinals.every((value) => typeof value === 'number') ||
        new Set(ordinals).size !== ordinals.length
      ) {
        throw new Error('Invalid retained TEST event order')
      }
      const map = (value: RecordedValue) =>
        rows(value).map((entry) => ({
          ...entry,
          ordinal: ordinals.filter((ordinal) => Number(ordinal) < Number(entry.ordinal)).length + 1
        }))
      return {
        ...observation,
        sender: map(observation.sender),
        payloads: map(observation.payloads),
        effects: map(observation.effects)
      }
    }
    return probeIds.size
      ? { expected: rank(before), actual: rank(actual) }
      : { expected: before, actual }
  }
  const views = expected.checkpoints.map((checkpoint, index) =>
    project(checkpoint.observation, raw.checkpoints[index]!.observation, checkpoint.id)
  )
  return {
    expected: {
      ...expected,
      checkpoints: expected.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        observation: views[index]!.expected
      }))
    },
    actual: {
      ...raw,
      checkpoints: raw.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        observation: views[index]!.actual
      }))
    }
  }
}
