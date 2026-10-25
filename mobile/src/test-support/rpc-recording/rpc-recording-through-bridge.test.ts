import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import {
  createBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import {
  bridgedParityMembershipDrift,
  bridgedParityTallyDrift,
  BRIDGED_PARITY_EXCLUSIONS,
  BRIDGED_PARITY_FLAG,
  BRIDGED_PARITY_NAMEABLE,
  BRIDGED_PARITY_OFF,
  classifyBridgedParity,
  type BridgedParityClass,
  type BridgedParityEvidence
} from '../bridged-parity/divergence-classes'
import { C5_PAGE_CLOSURE } from '../bridged-parity/c5-page-closure'
import { C6_BROWSER_CLOSURE_FAMILIES } from '../bridged-parity/c6-browser-closure-families'
import { C2_PAGE_CLOSURE } from '../bridged-parity/c2-page-closure'
import { C1_PAGE_CLOSURE } from '../bridged-parity/c1-page-closure'
import { C3_PAGE_CLOSURE } from '../bridged-parity/c3-page-closure'
import {
  pageClosureDrift,
  pageClosureRunTotals,
  pageClosureTotals,
  readPageClosure,
  type BridgedParityVerdict,
  type PageClosureObservation
} from '../bridged-parity/page-closure'
import {
  divergingFields,
  paramsMismatchEvidence,
  recordingWithoutRpcMeta,
  refusalReleasedStream,
  refusedFrames,
  scriptsAbsentResultReply,
  withReplyMeta
} from '../bridged-parity/divergence-evidence'
import { familyGoldens, pilotGoldens } from './derived-goldens'
import { compareGolden, readGolden } from './golden-recording'
import { pilotMountAdapters } from './pilot-mount-adapters'
import type { Recording, RecordingScenario } from './recording-scenario'
import { readScenarios } from './scenario-input'
import type { ScriptedClientWrapper } from './scripted-rpc-transport'
import { runRecording } from './run-recording'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

// Replay every golden through the page bridge without rewriting native evidence; RPC_FOUNDATION_BRIDGE=0 skips locally.
// Compare identical runs in full and pin divergence totals, small-class membership and each page closure independently.
// Exclusions cover recorder-injected absent results, undefined params lost above serialization, and logical write ordinals.
// Stream-release differences stem from cancelling refused injected frames, not a different native wire contract.
// The reader accepts the transport’s reply shapes; retain zero-pinned counterfactual-meta replay to detect future narrowing.

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

const SESSION_ID = 'recording-session'
const BUILD_ID = 'recording-build'
/** `ready` out, `init` back: two deliveries, and a round to see that the session landed. */
const HANDSHAKE_ROUNDS = 4

type Replay = {
  recording: Recording | null
  thrown: unknown
  pairs: BridgePortPair<RpcClient>[]
}

const counts: Record<BridgedParityClass, number> = {
  'reply-meta-required': 0,
  'result-absent-settlement': 0,
  'result-absent-observation': 0,
  'result-absent-stream-release': 0,
  'params-undefined': 0,
  'write-ordinal': 0,
  unclassified: 0
}
let identical = 0
const members = new Map<BridgedParityClass, string[]>()
const samples = new Map<BridgedParityClass, string>()
const observed = new Map<string, PageClosureObservation>()

// Deliver init before mounting: screen getters require a ready bridge on their first render, and nothing else is queued yet.
function throughBridge(
  keep: (pair: BridgePortPair<RpcClient>) => void,
  rewriteToPage?: (json: string) => string
): ScriptedClientWrapper {
  return (client) => {
    const pair = createBridgePortPair({
      rpc: client,
      sessionId: SESSION_ID,
      buildId: BUILD_ID,
      rewriteToPage
    })
    keep(pair)
    for (let round = 0; round < HANDSHAKE_ROUNDS; round += 1) {
      if (pair.client.getShellSession() !== null) {
        return pair.client
      }
      pair.drainNow()
    }
    throw new Error('the page never received `init` from the bridge host')
  }
}

async function replay(
  id: string,
  scenarios: readonly RecordingScenario[],
  rewriteToPage?: (json: string) => string
): Promise<Replay> {
  const pairs: BridgePortPair<RpcClient>[] = []
  const checkpoints: Recording['checkpoints'] = []
  const named = scenarios.length > 1
  try {
    for (const scenario of scenarios) {
      const { adapters } = pilotMountAdapters(root, { device: scenario })
      const recording = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler(),
        throughBridge((pair) => pairs.push(pair), rewriteToPage)
      )
      for (const checkpoint of recording.checkpoints) {
        checkpoints.push(
          named ? { ...checkpoint, id: `${scenario.id}:${checkpoint.id}` } : checkpoint
        )
      }
    }
    return { recording: { scenario: id, checkpoints }, thrown: null, pairs }
  } catch (error) {
    return { recording: null, thrown: error, pairs }
  }
}

function explain(fields: readonly string[], run: Replay): string {
  const refused = refusedFrames(run.pairs.flatMap((pair) => pair.toPage))
  const [refusal] = refused
  const read = refusal === undefined ? null : readBridgeHostMessage(refusal)
  const kinds = run.pairs.flatMap((pair) => pair.diagnostics).map((diagnostic) => diagnostic.kind)
  return [
    `  fields    ${fields.slice(0, 4).join(', ') || '(none)'}`,
    `  threw     ${run.thrown instanceof Error ? run.thrown.message : '(nothing)'}`,
    `  refused   ${refused.length} frame(s)${
      read !== null && !read.ok ? `, first "${read.refusal}" on ${refusal?.slice(0, 200)}` : ''
    }`,
    `  page saw  ${kinds.join(', ') || '(no diagnostics)'}`
  ].join('\n')
}

function describeParamsMismatch(evidence: BridgedParityEvidence): string {
  const mismatch = evidence.paramsMismatch
  if (mismatch === null) {
    return ''
  }
  return [
    `  refused   ${mismatch.step}`,
    `  moved     ${mismatch.differingKeys.join(', ') || '(nothing)'}`,
    `  scripted  \`undefined\` at ${mismatch.undefinedValuedKeys.join(', ') || '(nothing)'}`,
    ''
  ].join('\n')
}

// Replay divergent goldens with added meta to detect reader narrowing; strip injected meta before comparing observations.
async function verdict(
  id: string,
  family: string,
  scenarios: readonly RecordingScenario[],
  run: Replay
): Promise<void> {
  const record = (name: BridgedParityVerdict): void => {
    observed.set(id, { family, verdict: name })
  }
  const expected = readGolden(directory, id)
  const fields = run.recording === null ? [] : divergingFields(expected.recording, run.recording)
  if (run.recording !== null && fields.length === 0) {
    // Not redundant with the field walk: this one also pins the encoding.
    compareGolden(expected, { ...expected, recording: run.recording })
    identical += 1
    record('identical')
    return
  }
  const asIf = await replay(id, scenarios, withReplyMeta)
  const asIfFields =
    asIf.recording === null
      ? []
      : divergingFields(expected.recording, recordingWithoutRpcMeta(asIf.recording))
  // A scenario is handed a pair as it starts, so the last pair belongs to the one that threw.
  const failing = scenarios[asIf.pairs.length - 1]
  const evidence: BridgedParityEvidence = {
    fixedByReplyMeta: asIf.recording !== null && asIfFields.length === 0,
    threwWhileRecording: asIf.recording === null,
    divergingFields: asIfFields,
    scriptsAbsentResultReply: scenarios.some(scriptsAbsentResultReply),
    paramsMismatch: paramsMismatchEvidence(asIf.thrown, failing, asIf.pairs.at(-1)?.toShell ?? []),
    refusalReleasedStream: asIf.pairs.some((pair) => refusalReleasedStream(pair.diagnostics))
  }
  const name = classifyBridgedParity(evidence)
  counts[name] += 1
  record(name)
  if (name === 'unclassified') {
    throw new Error(
      `Unclassified bridged divergence: ${id}\n${explain(fields, run)}\n${describeParamsMismatch(evidence)}with \`_meta\` supplied:\n${explain(asIfFields, asIf)}`
    )
  }
  members.set(name, [...(members.get(name) ?? []), id])
  if (!samples.has(name)) {
    samples.set(name, `${id}\n${explain(fields, run)}`)
  }
}

describe.skipIf(process.env[BRIDGED_PARITY_FLAG] === BRIDGED_PARITY_OFF)(
  'every golden replays through the page bridge, byte-identically or in a named class',
  () => {
    for (const pilot of pilotGoldens(input.scenarios)) {
      it(`${pilot.id}: bridged parity`, async () => {
        await verdict(
          pilot.id,
          pilot.family,
          [pilot.scenario],
          await replay(pilot.id, [pilot.scenario])
        )
      })
    }
    for (const golden of familyGoldens(input.scenarios)) {
      it(
        `${golden.id}: bridged parity`,
        async () => {
          const scenarios = [...golden.scenarios()]
          await verdict(golden.id, golden.family, scenarios, await replay(golden.id, scenarios))
        },
        golden.timeoutMs
      )
    }
    it('replays every golden byte for byte or in a class a predicate excludes by name', () => {
      const table = [
        `identical ${identical}`,
        ...Object.entries(counts).map(([name, count]) => {
          const named = members.get(asClass(name)) ?? []
          return count > 0 && count <= BRIDGED_PARITY_NAMEABLE
            ? `${name} ${count}: ${named.join(', ')}`
            : `${name} ${count}`
        })
      ].join('\n')
      const corpus = identical + total(counts)
      const excluded = Object.entries(counts).filter(
        ([name]) => BRIDGED_PARITY_EXCLUSIONS[asClass(name)] !== undefined
      )
      const excludedCount = total(Object.fromEntries(excluded))
      process.stdout.write(`\nbridged parity over ${corpus} goldens\n${table}\n`)
      process.stdout.write(`\nexcluded ${excludedCount} of ${corpus}, each with the reason it is\n`)
      for (const [name, count] of excluded) {
        process.stdout.write(`  ${name} ${count}: ${BRIDGED_PARITY_EXCLUSIONS[asClass(name)]}\n`)
      }
      for (const [name, sample] of samples) {
        process.stdout.write(`\n${name} sample\n${sample}\n`)
      }
      expect(counts.unclassified).toBe(0)
      // Pin membership: one real refusal can enter an excluded class while another leaves without changing totals.
      expect({ membership: bridgedParityMembershipDrift(members) }).toEqual({ membership: [] })
      expect({ divergedOutsideAnExcludedClass: total(counts) - excludedCount }).toEqual({
        divergedOutsideAnExcludedClass: 0
      })
      // Pin identical as well as divergence totals so improvements cannot silently hide class movement.
      expect({ tally: bridgedParityTallyDrift({ identical, counts }) }).toEqual({ tally: [] })
    })

    it('gives every golden the C1 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C1', C1_PAGE_CLOSURE, observed))
      // Pin every closure id; aggregate corpus totals can trade a domain regression for an unrelated improvement.
      expect({ closure: pageClosureDrift(C1_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      // Check run totals independently because C1’s table has no separate class-count pins.
      expect(pageClosureRunTotals(C1_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C1_PAGE_CLOSURE)
      )
    })

    it('gives every golden the C5 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C5', C5_PAGE_CLOSURE, observed))
      // Recheck inherited C1 families alongside C5’s additions so shared regressions fail both closures.
      expect({ closure: pageClosureDrift(C5_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      // Independent totals detect a table and verdict reader agreeing on the same derivation error.
      expect(pageClosureRunTotals(C5_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C5_PAGE_CLOSURE)
      )
    })

    it('gives every golden the C2 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C2', C2_PAGE_CLOSURE, observed))
      // Recheck inherited families too; families with no identical golden can pin only their divergence class.
      expect({ closure: pageClosureDrift(C2_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      expect(pageClosureRunTotals(C2_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C2_PAGE_CLOSURE)
      )
    })

    // Check the C6 browser half now even though a later series composes its page closure.
    it('gives every golden the C6 browser closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C6', C6_BROWSER_CLOSURE_FAMILIES, observed))
      expect({ closure: pageClosureDrift(C6_BROWSER_CLOSURE_FAMILIES, observed) }).toEqual({
        closure: []
      })
      expect(pageClosureRunTotals(C6_BROWSER_CLOSURE_FAMILIES, observed)).toEqual(
        pageClosureTotals(C6_BROWSER_CLOSURE_FAMILIES)
      )
    })

    it('gives every golden the C3 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C3', C3_PAGE_CLOSURE, observed))
      // Recheck inherited C1 families; every added C3 family has byte-identical coverage.
      expect({ closure: pageClosureDrift(C3_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      expect(pageClosureRunTotals(C3_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C3_PAGE_CLOSURE)
      )
    })
  }
)

function total(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, count) => sum + count, 0)
}

function asClass(name: string): BridgedParityClass {
  if (!(name in counts)) {
    throw new Error(`Not a bridged parity class: ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `name in counts` was just checked, and `counts` has exactly the union's keys.
  return name as BridgedParityClass
}
