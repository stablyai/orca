import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type {
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillPlan,
  BundledSkillPlanEntry
} from '../../../shared/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import { hasCloudReceipt, hasPendingCloudTransaction, stateKeysFor } from './cloud-state'
import {
  bundledSkillTextDigest,
  classifyBundledSkillPath,
  type BundledSkillFolderClass
} from './classify'
import type { BundledSkillFilesystem } from './filesystem'
import { recoverySiblings } from './swap-recovery'
import { findBundledSkillSource, planFormerSkillPlacements } from './renamed-skill-placement'
import {
  bundledSkillPathKey,
  resolveBundledSkillRealPath,
  resolveBundledSkillTargets,
  type BundledSkillTargetRequest,
  type BundledSkillTargetRoot
} from './targets'

export type BundledSkillPlanInput = BundledSkillTargetRequest & {
  /** Bundled skill names; every bundled skill when omitted. */
  names?: readonly string[]
  /** Target paths the user chose to Replace; `all` is `--force`, every replaceable one. */
  force?: readonly string[] | 'all'
  /** Update existing locations only; never spread the skill to another agent. Skip skills with no Orca copy. */
  installedOnly?: boolean
  /** `<userData>/skill-installs`, where cloud installs keep receipts and journals. */
  stateDirectory: string
  filesystem: BundledSkillFilesystem
  sources: readonly BundledSkillSource[]
}

export type ResolvedBundledSkillPlan = {
  plan: BundledSkillPlan
  roots: BundledSkillTargetRoot[]
}

type SkillContext = {
  input: BundledSkillPlanInput
  source: BundledSkillSource
  digest: string
  force: Set<string> | 'all'
  sharedRoot?: BundledSkillTargetRoot
}

type SharedTarget = { path: string; realPath: string; current: boolean }

const WRITES_SHARED_CURRENT = new Set<BundledSkillOp['kind']>([
  'keep',
  'write',
  'update',
  'replace'
])

/** Fixed plan construction order makes JSON serialization canonical. */
export function bundledSkillDigestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sameBundledSkillObserved(
  left: BundledSkillObserved,
  right: BundledSkillObserved
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function linkPointsAt(
  filesystem: BundledSkillFilesystem,
  path: string,
  rawTarget: string,
  realPath: string
): Promise<boolean> {
  const resolved =
    (await filesystem.realpath(path)) ??
    resolve(await resolveBundledSkillRealPath(filesystem, dirname(path)), rawTarget)
  return bundledSkillPathKey(resolved) === bundledSkillPathKey(realPath)
}

type PlannedTarget = {
  op: BundledSkillOp
  holdsOrcaCopy: boolean
  formerInstalled: boolean
  leaves: BundledSkillOp[]
}

const ORCA_COPY_CLASSES = new Set<BundledSkillFolderClass>(['current', 'released', 'edited'])

async function planTarget(
  context: SkillContext,
  root: BundledSkillTargetRoot,
  shared: SharedTarget | null
): Promise<PlannedTarget> {
  const { filesystem, stateDirectory } = context.input
  const path = join(root.path, context.source.name)
  const realPath = join(root.realPath, context.source.name)
  const stateKeys = stateKeysFor(path, realPath)
  const classified = await classifyBundledSkillPath(
    filesystem,
    path,
    context.source,
    context.digest,
    context.force === 'all' || context.force.has(bundledSkillPathKey(path))
  )
  const { observed } = classified
  const former = await planFormerSkillPlacements(
    context.input,
    root,
    context.source,
    context.digest,
    context.sharedRoot
  )
  let folderClass: BundledSkillFolderClass = classified.folderClass
  // Cloud receipts identify a different package; a current replaced copy must settle as keep.
  if (
    (folderClass === 'released' || folderClass === 'edited') &&
    (await hasCloudReceipt(stateDirectory, stateKeys))
  ) {
    folderClass = 'other'
  }
  const { restoreFrom, cleanup } = await recoverySiblings(
    filesystem,
    context.source,
    context.digest,
    root,
    folderClass === 'absent'
  )
  const base = { path, role: root.role, agents: root.agents, observed }
  const leave = (reason: NonNullable<BundledSkillOp['reason']>, replaceable: boolean) =>
    ({ ...base, kind: 'leave', reason, replaceable, cleanup }) satisfies BundledSkillOp
  const files = (kind: 'write' | 'update' | 'copy' | 'replace'): BundledSkillOp => ({
    ...base,
    kind,
    content: 'files',
    cleanup
  })
  // Do not link until the shared-copy operation succeeds.
  const linkToShared = (kind: 'link' | 'replace', target: SharedTarget): BundledSkillOp => ({
    ...base,
    kind,
    content: 'link',
    linkTarget: target.path,
    requires: target.path,
    cleanup
  })

  const decide = async (): Promise<BundledSkillOp> => {
    if (observed.kind === 'unreadable') {
      return leave('unreadable', false)
    }
    if (restoreFrom) {
      return { ...base, kind: 'restore', restoreFrom, cleanup }
    }
    switch (folderClass) {
      case 'current':
        return { ...base, kind: 'keep', cleanup }
      case 'released':
        return files('update')
      case 'absent':
        if (!shared) {
          return files('write')
        }
        if (!shared.current && former.installed) {
          return files('write')
        }
        if (!shared.current) {
          return leave('shared-not-current', false)
        }
        return filesystem.supportsLinks ? linkToShared('link', shared) : files('copy')
      case 'edited':
      case 'other':
        break
    }
    if (
      shared &&
      observed.kind === 'link' &&
      (await linkPointsAt(filesystem, path, observed.target, shared.realPath))
    ) {
      return shared.current
        ? { ...base, kind: 'keep', cleanup }
        : leave('shared-not-current', false)
    }
    if (context.force !== 'all' && !context.force.has(bundledSkillPathKey(path))) {
      return leave(folderClass === 'edited' ? 'edited' : 'other', true)
    }
    return shared?.current && filesystem.supportsLinks
      ? linkToShared('replace', shared)
      : files('replace')
  }

  const holdsOrcaCopy =
    former.installed || Boolean(restoreFrom) || ORCA_COPY_CLASSES.has(folderClass)
  const decision = await decide()
  const decided =
    decision.kind === 'keep' &&
    observed.kind === 'folder' &&
    former.previous.some((previous) => !previous.retain)
      ? files('update')
      : decision
  const op =
    WRITES_SHARED_CURRENT.has(decided.kind) || decided.kind === 'copy' || decided.kind === 'link'
      ? {
          ...decided,
          ...(former.previous.length &&
          !(decided.kind === 'keep' && former.previous.every((previous) => previous.retain))
            ? { previous: former.previous }
            : {})
        }
      : decided
  const result = { holdsOrcaCopy, formerInstalled: former.installed, leaves: former.leaves }
  const writes = op.kind !== 'keep' && op.kind !== 'leave'
  if (!writes && op.cleanup.length === 0 && !op.previous?.length) {
    return { op, ...result }
  }
  const blocked = (await hasPendingCloudTransaction(stateDirectory, stateKeys))
    ? 'busy'
    : (await filesystem.canWrite(root.realPath))
      ? null
      : 'unwritable'
  if (!blocked) {
    return { op, ...result }
  }
  return {
    op: { ...(writes ? leave(blocked, false) : op), cleanup: [], previous: undefined },
    ...result
  }
}

async function planSkill(
  input: BundledSkillPlanInput,
  roots: readonly BundledSkillTargetRoot[],
  source: BundledSkillSource
): Promise<BundledSkillPlanEntry | null> {
  const context: SkillContext = {
    input,
    source,
    digest: bundledSkillTextDigest(Buffer.from(source.text, 'utf8')),
    force: input.force === 'all' ? 'all' : new Set((input.force ?? []).map(bundledSkillPathKey)),
    sharedRoot: roots.find((root) => root.role === 'shared')
  }
  const sharedRoot = roots.find((root) => root.role === 'shared')
  const agentRoots = roots.filter((root) => root.role === 'agent')
  const sharedTarget = sharedRoot ? await planTarget(context, sharedRoot, null) : null
  const shared: SharedTarget | null =
    sharedRoot && sharedTarget
      ? {
          path: sharedTarget.op.path,
          realPath: join(sharedRoot.realPath, source.name),
          current: WRITES_SHARED_CURRENT.has(sharedTarget.op.kind)
        }
      : null
  const planAgents = async (target: SharedTarget | null) => {
    const agents: PlannedTarget[] = []
    for (const root of agentRoots) {
      agents.push(await planTarget(context, root, target))
    }
    return agents
  }
  let agents = await planAgents(shared)
  const targets = [...(sharedTarget ? [sharedTarget] : []), ...agents]
  if (!input.installedOnly) {
    return {
      name: source.name,
      digest: context.digest,
      ops: targets.flatMap((target) => [target.op, ...target.leaves])
    }
  }
  if (!targets.some((target) => target.holdsOrcaCopy)) {
    return null
  }
  // Only repair an existing agent link into an empty shared slot; other updates must not create a new shared copy.
  const keepShared =
    sharedTarget &&
    (sharedTarget.formerInstalled ||
      isPresent(sharedTarget.op) ||
      agents.some((target) => target.op.kind === 'keep' && target.op.observed.kind === 'link'))
  if (!keepShared && shared?.current) {
    agents = await planAgents({ ...shared, current: false })
  }
  const ops = [
    ...(keepShared ? [sharedTarget.op, ...sharedTarget.leaves] : []),
    ...agents.flatMap((target) =>
      target.formerInstalled || isPresent(target.op) ? [target.op, ...target.leaves] : []
    )
  ]
  return { name: source.name, digest: context.digest, ops }
}

/** Interrupted siblings count as presence even when the target is absent. */
function isPresent(op: BundledSkillOp): boolean {
  return op.observed.kind !== 'absent' || op.restoreFrom !== undefined || op.cleanup.length > 0
}

/** Preview and execute share planning; execution requires the same digest before applying it. */
export async function buildBundledSkillPlan(
  input: BundledSkillPlanInput
): Promise<ResolvedBundledSkillPlan> {
  const roots = await resolveBundledSkillTargets(input, input.filesystem)
  const selected = input.names
    ? [...new Set(input.names.map((name) => findBundledSkillSource(input.sources, name)))]
    : input.sources
  const skills: BundledSkillPlanEntry[] = []
  for (const source of selected) {
    const entry = await planSkill(input, roots, source)
    if (entry) {
      skills.push(entry)
    }
  }
  return {
    plan: {
      scope: input.destination.scope,
      homeDirectory: input.destination.homeDirectory,
      skills,
      planDigest: bundledSkillDigestOf(skills)
    },
    roots
  }
}
