import { strictReplayVerdict, type BridgedReplay } from '../bridged-parity/replay-verdict'
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
  refusedFrames,
  refusalReleasedStream,
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

/**
 * The ten changed History goldens receive complete residual certification. Other goldens retain
 * their pre-existing regression labels and per-id/page/tally drift checks; those legacy labels
 * are not causal parity proofs. Their known recorder coverage gaps remain outside this change.
 * The reply-meta counterfactual and raw recordings are preserved for both paths.
 */

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

/** One document's turn at the bridge is the whole recording, so both are constants. */
const SESSION_ID = 'recording-session'
const BUILD_ID = 'recording-build'
/** `ready` out, `init` back: two deliveries, and a round to see that the session landed. */
const HANDSHAKE_ROUNDS = 4

type Replay = BridgedReplay

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
/** Every golden's own verdict, which is what the C1 closure is pinned against golden by golden. */
const observed = new Map<string, PageClosureObservation>()

/**
 * The page's client over the shared port pair, holding the recorder's scripted client shell-side.
 *
 * The handshake is delivered in place because `BridgeRpcClient` refuses every member until `init`
 * has landed and its getters are what a screen reads during its first render, so a mount that raced
 * it would record a different first render. Nothing else has been queued at this point, so draining
 * here cannot reorder anything.
 */
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

/** Everything the run knows about why it diverged, so a new class arrives readable, not as a stall. */
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

/** The params a refused step moved, named beside the fields, so a wire bug arrives readable. */
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

/**
 * The verdict on one golden, and where it diverged, the counterfactual that says why.
 *
 * The second replay runs only for a golden that already diverged, and it is the one question the
 * page cannot be asked any other way: the reader wants a `_meta` the wire it stands in for does not
 * send, so a run where the lane supplies it separates what that costs from what the payload itself
 * does. Its own `_meta` comes back off before the diff, because a reply the page accepts resolves
 * to the caller whole.
 */
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
  const certified =
    Object.hasOwn(C5_PAGE_CLOSURE['aiVault.history'] ?? {}, id) ||
    Object.hasOwn(C5_PAGE_CLOSURE['aiVault.history-screen'] ?? {}, id)
  const fields = run.recording === null ? [] : divergingFields(expected.recording, run.recording)
  if (!certified && run.recording !== null && fields.length === 0) {
    // Not redundant with the field walk: this one also pins the encoding.
    compareGolden(expected, { ...expected, recording: run.recording })
    identical += 1
    record('identical')
    return
  }
  const asIf = await replay(id, scenarios, withReplyMeta)
  if (certified) {
    const result = strictReplayVerdict(expected.recording, scenarios, run, asIf)
    if (result.name === 'unclassified') {
      throw new Error(
        `Unclassified bridged divergence: ${id}\noriginal (${result.original.name}):\n${explain(result.original.fields, run)}\nwith \`_meta\` supplied (${result.replyMeta.name}):\n${explain(result.replyMeta.fields, asIf)}`
      )
    }
    if (result.name === 'identical') {
      compareGolden(expected, { ...expected, recording: run.recording! })
      identical += 1
      record('identical')
      return
    }
    counts[result.name] += 1
    record(result.name)
    members.set(result.name, [...(members.get(result.name) ?? []), id])
    if (!samples.has(result.name)) {
      samples.set(result.name, `${id}\n${explain(fields, run)}`)
    }
    return
  }
  const asIfFields =
    asIf.recording === null
      ? []
      : divergingFields(expected.recording, recordingWithoutRpcMeta(asIf.recording))
  // A scenario is handed a pair as it starts, so the last pair belongs to the one that threw.
  const failing = scenarios[asIf.pairs.length - 1]
  const scriptsAbsent = scenarios.some(scriptsAbsentResultReply)
  const evidence: BridgedParityEvidence = {
    fixedByReplyMeta: asIf.recording !== null && asIfFields.length === 0,
    threwWhileRecording: asIf.recording === null,
    divergingFields: asIfFields,
    absentResultExplainsResiduals: false,
    paramsMismatch: paramsMismatchEvidence(asIf.thrown, failing, asIf.pairs.at(-1)?.toShell ?? []),
    refusalReleasedStream:
      scriptsAbsent && asIf.pairs.some((pair) => refusalReleasedStream(pair.diagnostics)),
    legacyBaseline: {
      firstField:
        asIf.recording === null
          ? undefined
          : divergingFields(expected.recording, recordingWithoutRpcMeta(asIf.recording), false)[0],
      scriptsAbsentResultReply: scriptsAbsent
    }
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
  'History parity certification and unchanged corpus baseline membership',
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
    it('preserves measured strict and legacy membership without unexplained changed History residuals', () => {
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
      process.stdout.write(
        `\nHistory certification and legacy membership over ${corpus} goldens\n${table}\n`
      )
      process.stdout.write(
        `\nlabelled recorder limitations ${excludedCount} of ${corpus}; unchanged labels are baseline only\n`
      )
      for (const [name, count] of excluded) {
        process.stdout.write(`  ${name} ${count}: ${BRIDGED_PARITY_EXCLUSIONS[asClass(name)]}\n`)
      }
      for (const [name, sample] of samples) {
        process.stdout.write(`\n${name} sample\n${sample}\n`)
      }
      expect(counts.unclassified).toBe(0)
      // Not implied by the counts below. A class is named by a predicate that reads the scenario,
      // not the frame the page refused, so a golden that started refusing for real can walk into an
      // excluded class while another walks out and no number here moves.
      expect({ membership: bridgedParityMembershipDrift(members) }).toEqual({ membership: [] })
      // The whole claim in one line: nothing diverges that no predicate has named and counted.
      expect({ divergedOutsideAnExcludedClass: total(counts) - excludedCount }).toEqual({
        divergedOutsideAnExcludedClass: 0
      })
      // Every count exactly, `identical` included, which is the direction the three checks above
      // cannot see: a golden reported `identical` rather than the excluded class it belongs to
      // leaves all three holding. The size of the corpus follows, being the total of these.
      expect({ tally: bridgedParityTallyDrift({ identical, counts }) }).toEqual({ tally: [] })
    })

    it('gives every golden the C1 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C1', C1_PAGE_CLOSURE, observed))
      // Each by id, because the counts above cannot see this domain: a closure golden that stopped
      // replaying identically is paid for by any of the other 684 that started.
      expect({ closure: pageClosureDrift(C1_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      // And the run's own totals over this closure, as the two blocks below do. `c1-page-closure.ts`
      // pins no class counts of its own, so without this a verdict edited inside that file is green
      // everywhere C1 is read alone.
      expect(pageClosureRunTotals(C1_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C1_PAGE_CLOSURE)
      )
    })

    it('gives every golden the C5 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C5', C5_PAGE_CLOSURE, observed))
      // C1's 22 families are inside these 27, so this repeats their check and adds the five AI
      // Vault families C5 owns. The repetition is the point: a golden that moved between the two
      // domains' shared families has to fail both rather than be argued about.
      expect({ closure: pageClosureDrift(C5_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      // The run's own totals over this closure, against the pin's. A per-id walk agrees with a
      // table that is wrong the same way twice; the counts are what caught exactly that while the
      // file was being derived.
      expect(pageClosureRunTotals(C5_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C5_PAGE_CLOSURE)
      )
    })

    it('gives every golden the C2 page closure records the verdict it is pinned to', () => {
      process.stdout.write(readPageClosure('C2', C2_PAGE_CLOSURE, observed))
      // 70 families and 266 goldens, C1's 22 among them and inherited rather than re-derived, so
      // this repeats their check too. Five of the families it adds have no byte-identical golden at
      // all: there the pin holds the class, which is the whole of what it can hold.
      expect({ closure: pageClosureDrift(C2_PAGE_CLOSURE, observed) }).toEqual({ closure: [] })
      expect(pageClosureRunTotals(C2_PAGE_CLOSURE, observed)).toEqual(
        pageClosureTotals(C2_PAGE_CLOSURE)
      )
    })

    /**
     * The browser pane's half, checked the same way and for the same reason the composed tables are.
     *
     * A half rather than a page closure because C6 registers no route — C7 composes this beside
     * C1's — but a table nothing reads is not a pin, so the run is held to it here from the series
     * that derived it rather than from the one that will inherit it.
     */
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
      // 28 families and 125 goldens, C1's 22 among them and inherited rather than re-derived, so
      // this repeats their check too. One family it inherits has no byte-identical golden at all;
      // all six it adds have at least one, so for those the pin holds bytes and not only a name.
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

/** The keys are this union by construction; the lookup below is what needs to say so. */
function asClass(name: string): BridgedParityClass {
  if (!(name in counts)) {
    throw new Error(`Not a bridged parity class: ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `name in counts` was just checked, and `counts` has exactly the union's keys.
  return name as BridgedParityClass
}
