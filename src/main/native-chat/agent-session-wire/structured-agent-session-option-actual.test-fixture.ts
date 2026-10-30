import {
  PiRpcOptionObservations,
  applyPiRpcSessionOption,
  type PiRpcOptionProof
} from '../../pi/rpc-options'
import { captureStructuredExecutionOptions } from './structured-agent-session-execution-options'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { PI_RPC_AGENT } from '../../pi/rpc-agent-definition'
import { PiRpcSessionAdapter } from '../../pi/rpc-session-adapter'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { expect, it } from 'vitest'
import type { piOptionRefreshHost } from './structured-agent-session-option-refresh.test-fixture'
import type {
  PiRefreshHarness,
  PiRefreshMount
} from '../../../shared/structured-agent-session-option-refresh.test-fixture-contract'

const precise = ['off', 'minimal', 'low', 'high', 'xhigh'].map((value) => ({ value, label: value }))
const effort = (view: PiRefreshHarness) => view.snapshot().find((entry) => entry.id === 'effort')

export function piOptionActualContract(
  makeHost: typeof piOptionRefreshHost,
  mount: PiRefreshMount,
  flush: (work: () => void) => Promise<void>
): void {
  it('keeps cold matched actual display separate from raw capture through equal picks and context replacement', async () => {
    const host = makeHost()
    host.record.options.effort = 'off'
    const proof: PiRpcOptionProof = { current: new Map(), writes: new Map() }
    const setters: string[] = []
    const rpc = {
      request: async (command: string) => {
        setters.push(command)
        return {}
      }
    }
    await applyPiRpcSessionOption(rpc, new Map(), 'model', host.record.options.model, {}, proof)
    await applyPiRpcSessionOption(rpc, new Map(), 'effort', 'off', {}, proof)
    const observations = new PiRpcOptionObservations(proof, () => true)
    const observe = (effort: string) => {
      observations.prepare()({
        models: host.home.models,
        current: {
          model: host.record.options.model,
          effort,
          confirmed: ['model', 'effort']
        }
      })
      host.live = observations.read()
    }
    observe('minimal')
    const answer = await host.read()
    expect(answer.current).toMatchObject({ effort: 'off', reportedEffort: 'minimal' })
    expect(answer.current.confirmed).not.toContain('effort')
    host.hostReads = 0
    const view = await mount(host)
    expect(effort(view)).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'minimal', choices: precise }
    })
    expect(view.capture()?.effort).toBe('off')
    observe('low')
    await flush(() => host.initialCatalog.resolve(host.home))
    await flush(() => host.finish(0))
    expect(effort(view)).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'low', choices: precise }
    })
    await flush(() => {
      void view.pick('off')
    })
    expect(effort(view)?.valueSource).not.toBe('reported')
    expect(view.capture()?.effort).toBe('off')
    await flush(() => host.finish(1))
    expect(host.requests.length).toBeLessThanOrEqual(3)
    if (host.requests.length === 3) {
      await flush(() => host.finish(2))
    }
    expect(effort(view)?.kind.currentValue).toBe('low')
    const frozen = view.capture()!
    host.record.options.effort = 'high'
    const accepted = captureStructuredExecutionOptions(
      {
        agent: 'pi',
        agents: new StructuredAgentRegistry([
          {
            definition: PI_RPC_AGENT,
            adapter: new PiRpcSessionAdapter({
              logger: createStructuredAgentSessionLogger(),
              onLifecycle: () => {},
              onSettled: () => {},
              resolveLaunch: async () => {
                throw new Error('capture does not launch')
              }
            })
          }
        ]),
        persistedOptions: host.record.options
      },
      undefined,
      frozen
    )
    expect(accepted).toMatchObject({ options: { effort: 'off' } })
    expect(proof.current.get('effort')).toBe('off')
    expect(setters).toEqual(['set_model', 'set_thinking_level'])
    host.record.options.effort = 'off'
    host.live = {
      models: host.home.models,
      current: { model: host.record.options.model, effort: 'off' }
    }
    const replacement = host.requests.length
    await view.replace(3)
    expect(effort(view)?.kind.currentValue).not.toBe('low')
    await flush(() => host.finish(replacement))
    expect(effort(view)?.valueSource).not.toBe('reported')
    expect(view.capture()?.effort).toBe('off')
    await view.close()
  })
}
