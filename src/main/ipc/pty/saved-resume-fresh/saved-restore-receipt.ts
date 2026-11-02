import { randomUUID } from 'node:crypto'
import { agentHookServer } from '../../../agent-hooks/server'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'
import type { AgentStatusCacheIdentity } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import {
  onAgentSessionOwnerAdopted,
  releaseAgentSessionOwnerForFresh
} from '../pane/agent-session-owner-release'
import { probeSavedResumeStore } from './store-presence'
import type { SavedResumeStoreQuery, SavedRestoreRoots } from './store-query'

// A shell's startup files run between the spawn and the check; the receipt waits that long at most.
const RECEIPT_TTL_MS = 120_000
// The generated line reports its fresh dispatch right after the answer reaches it.
const DISPATCH_TTL_MS = 30_000
const MAX_STORE_READ_MS = 3_000
// Leaves the reply time to reach the CLI before its own budget ends.
const REPLY_MARGIN_MS = 250

export type SavedRestoreLaunch = {
  ptyId: string
  incarnationId: string | undefined
  owner: AgentSessionOwnerBinding | undefined
  launchToken: string | undefined
}

type Receipt = {
  paneKey: string
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  resumeArgs: string[]
  worktreeId: string | undefined
  admission: Extract<ResumeSpawnAdmission, { verdict: 'admitted' }>
  settings: SavedResumeStoreQuery['settings']
  mintedAt: number
  /** Settles once the spawn published its PTY and owner, or null when it never will. */
  launch: Promise<SavedRestoreLaunch | null>
  settleLaunch: (launch: SavedRestoreLaunch | null) => void
  launched?: SavedRestoreLaunch
  /** An explicit open adopted this launch's owner: it keeps the conversation it asked for. */
  adopted?: true
}

type FreshDispatch = {
  receipt: Receipt
  launch: SavedRestoreLaunch
  seed: AgentStatusCacheIdentity
  dispatchId: string
}

const receipts = new Map<string, Receipt>()
/** Consumed receipts whose decision is still running. */
const deciding = new Set<Receipt>()
const dispatches = new Map<string, FreshDispatch>()
let stopWatchingAdoption: (() => void) | null = null

function expire<T>(map: Map<string, T>, proof: string, entry: T, ms: number): void {
  setTimeout(() => {
    if (map.get(proof) === entry) {
      map.delete(proof)
      if (map === receipts) {
        ;(entry as Receipt).settleLaunch(null)
      }
    }
  }, ms).unref?.()
}

function sameOwner(a: AgentSessionOwnerBinding, b: AgentSessionOwnerBinding): boolean {
  return a.ptyId === b.ptyId && a.generation === b.generation
}

function watchAdoption(): void {
  stopWatchingAdoption ??= onAgentSessionOwnerAdopted((owner) => {
    for (const receipt of [...receipts.values(), ...deciding]) {
      if (receipt.launched?.owner && sameOwner(receipt.launched.owner, owner)) {
        receipt.adopted = true
      }
    }
    for (const [proof, dispatch] of dispatches) {
      if (dispatch.launch.owner && sameOwner(dispatch.launch.owner, owner)) {
        dispatches.delete(proof)
      }
    }
  })
}

export function mintSavedRestoreReceipt(
  proof: string,
  facts: Omit<Receipt, 'mintedAt' | 'launch' | 'settleLaunch' | 'agent'> & { agent: string }
): void {
  watchAdoption()
  let settleLaunch!: Receipt['settleLaunch']
  const launch = new Promise<SavedRestoreLaunch | null>((resolve) => {
    settleLaunch = resolve
  })
  const receipt: Receipt = {
    ...facts,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: armed only for TUI agents.
    agent: facts.agent as TuiAgent,
    mintedAt: Date.now(),
    launch,
    settleLaunch
  }
  receipts.set(proof, receipt)
  expire(receipts, proof, receipt, RECEIPT_TTL_MS)
}

/** The spawn committed a new PTY for this restore; a reattach, adoption or failure never does. */
export function settleSavedRestoreLaunch(
  proof: string | undefined,
  launch: SavedRestoreLaunch | null
): void {
  const receipt = proof ? receipts.get(proof) : undefined
  if (!receipt || receipt.launched) {
    return
  }
  if (launch) {
    receipt.launched = launch
  } else {
    receipts.delete(proof!)
  }
  receipt.settleLaunch(launch)
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())).unref?.()
    )
  ])
}

export type SavedRestoreCheck = {
  token: string
  agent: string
  args: string[]
  roots: SavedRestoreRoots
  cwd: string
  remainingMs: number
}

/** Main's one decision: fresh only when this generated invocation's own store definitively lacks
 *  the conversation, the pane still shows only this launch's seed, and the old conversation's
 *  owner binding on this PTY was released where it lives. Anything else resumes as asked. */
export async function decideSavedRestore(check: SavedRestoreCheck): Promise<'fresh' | 'resume'> {
  const receipt = receipts.get(check.token)
  // Consumed before any wait: a replayed or concurrent receipt can never decide again.
  receipts.delete(check.token)
  if (!receipt) {
    return 'resume'
  }
  deciding.add(receipt)
  try {
    return await decide(receipt, check)
  } finally {
    deciding.delete(receipt)
  }
}

async function decide(receipt: Receipt, check: SavedRestoreCheck): Promise<'fresh' | 'resume'> {
  if (
    receipt.agent !== check.agent ||
    receipt.resumeArgs.length !== check.args.length ||
    receipt.resumeArgs.some((arg, index) => arg !== check.args[index])
  ) {
    return 'resume'
  }
  const deadline = Date.now() + Math.min(MAX_STORE_READ_MS, check.remainingMs - REPLY_MARGIN_MS)
  const seedNow = () =>
    agentHookServer.launchSeedSince(
      receipt.paneKey,
      receipt.agent,
      receipt.providerSession,
      receipt.mintedAt
    )
  const launch = await beforeDeadline(receipt.launch, deadline, null)
  if (!launch || receipt.adopted || !seedNow()) {
    return 'resume'
  }
  const presence = await probeSavedResumeStore(
    {
      agent: receipt.agent,
      providerSession: receipt.providerSession,
      roots: check.roots,
      cwd: check.cwd,
      recipeArgs: '',
      settings: receipt.settings
    },
    deadline
  )
  if (presence !== 'missing' || receipt.adopted || !seedNow()) {
    return 'resume'
  }
  if (
    launch.owner &&
    !(await releaseAgentSessionOwnerForFresh({
      owner: launch.owner,
      incarnationId: launch.incarnationId,
      deadline
    }))
  ) {
    return 'resume'
  }
  const seed = seedNow()
  if (!seed || receipt.adopted || Date.now() > deadline) {
    return 'resume'
  }
  const dispatch: FreshDispatch = { receipt, launch, seed, dispatchId: randomUUID() }
  dispatches.set(check.token, dispatch)
  expire(dispatches, check.token, dispatch, DISPATCH_TTL_MS)
  return 'fresh'
}

/** The generated line committed to its fresh arguments: forget the replaced conversation in this
 *  pane, then tell the pane's viewers once. A lost answer never gets here, so it changes nothing. */
export function completeSavedRestoreFresh(token: string, runtime: OrcaRuntimeService): void {
  const dispatch = dispatches.get(token)
  dispatches.delete(token)
  if (!dispatch) {
    return
  }
  const { receipt, launch, seed, dispatchId } = dispatch
  const refused = { ...receipt.admission.refused, expectedStatus: seed }
  try {
    agentHookServer.forgetRefusedPaneResume(receipt.paneKey, refused)
    runtime.releaseAgentSessionResumeHold(receipt.paneKey, {
      agent: receipt.agent,
      providerSession: receipt.providerSession
    })
  } catch (error) {
    // The fresh agent already runs; its first report replaces whatever row remains.
    console.warn('[pty] could not forget a saved restore that started fresh', error)
  }
  if (receipt.worktreeId) {
    void runtime
      .forgetRefusedSavedResume(
        receipt.worktreeId,
        receipt.paneKey,
        refused,
        receipt.admission.sourceRecord
      )
      .catch((error: unknown) => console.warn('[pty] saved restore cleanup failed', error))
  }
  runtime.publishTerminalSavedRestoreFresh({
    paneKey: receipt.paneKey,
    ptyId: launch.ptyId,
    incarnationId: launch.incarnationId,
    launchToken: launch.launchToken,
    dispatchId
  })
}
