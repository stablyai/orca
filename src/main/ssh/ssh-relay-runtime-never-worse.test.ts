/**
 * The ladder's invariant: for every host, the connect is never worse than the pre-ladder default
 * (the host-Node relay, `legacy`), never compiles where Orca's own runtime runs, and lands on
 * plain SSH only when that default itself answered with a failure. Drives the real step function
 * the deploy loop uses over the cross-product of what each rung and the default can answer.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteOperatingSystem } from './ssh-remote-platform'
import {
  relayRuntimeLadder,
  relayRuntimeStepAfterRefusal,
  type RelayRuntimeStep
} from './ssh-relay-runtime-ladder'
import type { RelayRuntimeFallbackReason } from './ssh-relay-pinned-node'

/**
 * A rung launches or answers with a refusal. Transport loss is covered in
 * ssh-relay-host-answered-failure.test.ts.
 */
type RungAnswer = 'launch' | RelayRuntimeFallbackReason
/**
 * The host-Node relay: it launches, its strict probe answers "no Node", its npm install answers
 * with a failure, or its relay launch fails after starting (which propagates, as before).
 */
type HostNodeAnswer = 'launch' | 'no_node' | 'install_fails' | 'launch_fails'

type HostCase = {
  id: string
  os: RemoteOperatingSystem
  a: RungAnswer
  b: RungAnswer
  c: RungAnswer
  hostNode: HostNodeAnswer
  /** Only A and B can replay a cached refusal (see ssh-relay-runtime-step-plan.ts). */
  rememberedA: boolean
  rememberedB: boolean
}

type Outcome =
  | { kind: 'relay'; rung: RelayRuntimeStep }
  | { kind: 'plain_ssh' }
  | { kind: 'failed' }

const RANK: Record<Outcome['kind'], number> = { relay: 2, plain_ssh: 1, failed: 0 }

/** Before the ladder: every connect ran the host-Node relay, and any failure failed the connect. */
function baseOutcome(host: HostCase): Outcome {
  return host.hostNode === 'launch' ? { kind: 'relay', rung: 'legacy' } : { kind: 'failed' }
}

/** The deploy loop: answered refusals step on; a launch failure propagates. */
function ladderOutcome(host: HostCase): Outcome {
  const ladder = relayRuntimeLadder('pinned-node')
  let step: RelayRuntimeStep = ladder[0]!
  for (let guard = 0; guard < 10; guard++) {
    let answer: RungAnswer
    switch (step) {
      case 'D':
        return { kind: 'plain_ssh' }
      case 'legacy':
        if (host.hostNode === 'launch') {
          return { kind: 'relay', rung: 'legacy' }
        }
        if (host.hostNode === 'launch_fails') {
          return { kind: 'failed' }
        }
        answer = host.hostNode === 'no_node' ? 'host_node_missing' : 'install_failed'
        break
      case 'A':
        answer = host.a
        break
      case 'B':
        answer = host.os === 'win32' ? 'runtime_unavailable' : host.b
        break
      case 'C':
        answer = host.os === 'win32' ? 'windows_host_unsupported' : host.c
        break
    }
    if (answer === 'launch') {
      return { kind: 'relay', rung: step }
    }
    const remembered = step === 'A' ? host.rememberedA : step === 'B' ? host.rememberedB : false
    step = relayRuntimeStepAfterRefusal(ladder, step, answer, remembered)
  }
  throw new Error(`ladder did not settle for ${host.id}`)
}

const A_ANSWERS: readonly RungAnswer[] = [
  'launch',
  'noexec',
  'missing_lib',
  'libc_floor',
  'illegal_instruction',
  'wrong_libc',
  'security_software',
  'target_unresolved',
  'artifacts_unavailable',
  'install_failed'
]
const B_ANSWERS: readonly RungAnswer[] = [
  'launch',
  'noexec',
  'runtime_unavailable',
  'install_failed'
]
const C_ANSWERS: readonly RungAnswer[] = [
  'launch',
  'host_node_missing',
  'noexec',
  'libc_floor',
  'artifacts_unavailable',
  'target_unresolved',
  'install_failed'
]
const HOST_NODE_ANSWERS: readonly HostNodeAnswer[] = [
  'launch',
  'no_node',
  'install_fails',
  'launch_fails'
]
const OSES: readonly RemoteOperatingSystem[] = ['linux', 'win32']
const REMEMBERED = [false, true] as const
const replayTag = (remembered: boolean): string => (remembered ? '(remembered)' : '')

const CROSS_PRODUCT: HostCase[] = OSES.flatMap((os) =>
  A_ANSWERS.flatMap((a) =>
    B_ANSWERS.flatMap((b) =>
      C_ANSWERS.flatMap((c) =>
        HOST_NODE_ANSWERS.flatMap((hostNode) =>
          REMEMBERED.flatMap((rememberedA) =>
            REMEMBERED.map((rememberedB) => ({
              id: `${os} A:${a}${replayTag(rememberedA)} B:${b}${replayTag(rememberedB)} C:${c} host:${hostNode}`,
              os,
              a,
              b,
              c,
              hostNode,
              rememberedA,
              rememberedB
            }))
          )
        )
      )
    )
  )
)

function violations(host: HostCase): string[] {
  const base = baseOutcome(host)
  const ladder = ladderOutcome(host)
  const found: string[] = []
  if (RANK[ladder.kind] < RANK[base.kind]) {
    found.push(`${host.id}: ${ladder.kind} is worse than base ${base.kind}`)
  }
  if (host.a === 'launch' && ladder.kind === 'relay' && ladder.rung !== 'A') {
    found.push(`${host.id}: compiled on the host though rung A runs`)
  }
  // D only when the host-Node default itself answered with a failure.
  if (ladder.kind === 'plain_ssh' && !['no_node', 'install_fails'].includes(host.hostNode)) {
    found.push(`${host.id}: plain SSH without the default failing`)
  }
  return found
}

describe('relay runtime ladder vs the pre-ladder host-Node default', () => {
  it(`is never worse across all ${CROSS_PRODUCT.length} host combinations`, () => {
    expect(CROSS_PRODUCT.flatMap(violations)).toEqual([])
  })
})
