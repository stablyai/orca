import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { preparationEntryKey, preparationPathKey } from './worktree-create-preparation-claim'
import type { DeferredPreparation } from './worktree-create-preparation-claim-registry'
import type { PreparationEntry } from './worktree-create-preparation-pool'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'

export type StartPreparationArgs = {
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  canonicalBase: string
  options: AddWorktreeOptions
  beforeMaterialization?: Promise<void>
  canPrepare?: () => boolean
}

export function selectPreparationVictim(
  entries: Iterable<PreparationEntry>,
  args: StartPreparationArgs
): PreparationEntry | undefined {
  const byAge = [...entries].sort((left, right) => left.createdAt - right.createdAt)
  return (
    byAge.find(
      (entry) =>
        entry.repoPathKey === preparationPathKey(args.repoPath) &&
        entry.workspaceRootKey === preparationPathKey(args.workspaceRoot) &&
        entry.wslDistro === (args.options.wslDistro ?? '')
    ) ?? byAge[0]
  )
}

type PreparationAdmissionIntent = {
  args: StartPreparationArgs
  kind: DeferredPreparation['kind']
  ready: Promise<void>
  signal: AbortSignal
  current(): boolean
  release(): void
  wait<T>(work: Promise<T>): Promise<T>
  cancel(): void
}

const intents = new Map<string, PreparationAdmissionIntent>()

function joinPreparationAdmission(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind'],
  limit: number,
  run: (intent: PreparationAdmissionIntent) => Promise<void>,
  reuse: () => Promise<void> | undefined
): Promise<void> {
  const key = preparationEntryKey(
    preparationPathKey(args.repoPath),
    preparationPathKey(args.workspaceRoot),
    args.canonicalBase,
    args.options.wslDistro ?? ''
  )
  const existing = intents.get(key)
  if (existing) {
    if (kind === 'explicit' || existing.kind !== 'explicit') {
      existing.kind = kind
      if (args.beforeMaterialization) {
        existing.args.beforeMaterialization = args.beforeMaterialization
      }
    }
    return existing.ready.then(() => (existing.signal.aborted ? undefined : reuse()))
  }
  if (intents.size >= limit) {
    return Promise.resolve()
  }
  const controller = new AbortController()
  const signal = args.options.signal
    ? AbortSignal.any([controller.signal, args.options.signal])
    : controller.signal
  const completion = Promise.withResolvers<void>()
  const intent: PreparationAdmissionIntent = {
    args: { ...args },
    kind,
    ready: completion.promise,
    signal,
    current: () => intents.get(key) === intent && !signal.aborted,
    release: () => {
      if (intents.get(key) === intent) {
        intents.delete(key)
      }
    },
    wait: (work) => waitForPromiseWithSignal(work, signal),
    cancel: () => {
      controller.abort()
      intent.release()
    }
  }
  intents.set(key, intent)
  void run(intent)
    .catch((error) => {
      if (!signal.aborted) {
        throw error
      }
    })
    .then(completion.resolve, completion.reject)
    .finally(intent.release)
  return intent.ready
}

export function cancelPreparationAdmissions(repoPathKey?: string): void {
  for (const intent of intents.values()) {
    if (!repoPathKey || preparationPathKey(intent.args.repoPath) === repoPathKey) {
      intent.cancel()
    }
  }
}

type AdmissionActions = {
  retry: Promise<void>
  reuse: (
    args: StartPreparationArgs,
    kind: DeferredPreparation['kind']
  ) => Promise<void> | undefined
  hasCapacity: () => boolean
  evict: (args: StartPreparationArgs) => Promise<void> | undefined
  start: (args: StartPreparationArgs, kind: DeferredPreparation['kind']) => Promise<void>
}

export function canPrepare(args: StartPreparationArgs): boolean {
  return (
    !args.options.signal?.aborted &&
    args.options.canStart?.() !== false &&
    args.canPrepare?.() !== false
  )
}

export function waitForPreparationAdmission(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind'],
  limit: number,
  actions: AdmissionActions
): Promise<void> {
  return joinPreparationAdmission(
    args,
    kind,
    limit,
    (intent) => recoverPreparationCapacity(intent, actions),
    () => (canPrepare(args) ? actions.reuse(args, kind) : undefined)
  )
}

async function recoverPreparationCapacity(
  intent: PreparationAdmissionIntent,
  actions: AdmissionActions
): Promise<void> {
  const { args } = intent
  const valid = (): boolean => intent.current() && canPrepare(args)
  const hostAvailable = (): Promise<boolean> =>
    intent
      .wait(blockedWslDistroForPath(args.repoPath, args.options.wslDistro))
      .then((blocked) => !blocked)
  await intent.wait(actions.retry)
  if (!valid() || !(await hostAvailable()) || !valid()) {
    return
  }
  let reused = actions.reuse(args, intent.kind)
  if (reused) {
    intent.release()
    return reused
  }
  if (!actions.hasCapacity()) {
    const removal = actions.evict(args)
    if (!removal) {
      return
    }
    await intent.wait(removal)
    if (!valid() || !(await hostAvailable()) || !valid()) {
      return
    }
    reused = actions.reuse(args, intent.kind)
    if (reused) {
      intent.release()
      return reused
    }
  }
  intent.release()
  return actions.start(args, intent.kind)
}
