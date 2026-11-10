// Keeps checkpoint refs bounded: the newest N under one prefix, and nothing older than a max age
// anywhere under refs/orca/checkpoints/. Deleting a ref only drops its reachability; git gc frees
// the objects later on its own schedule.

import { type CheckpointRepo, CHECKPOINT_REF_ROOT } from './worktree-checkpoint-git'

type RefAge = { ref: string; committedAt: number }

async function listRefs(repo: CheckpointRepo, prefix: string): Promise<RefAge[]> {
  const out = await repo.git([
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(committerdate:unix) %(refname)',
    prefix
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ')
      return {
        committedAt: Number(line.slice(0, space)) * 1000,
        ref: line.slice(space + 1)
      }
    })
}

export async function listCheckpointRefs(repo: CheckpointRepo, prefix: string): Promise<string[]> {
  return (await listRefs(repo, prefix)).map((entry) => entry.ref)
}

export async function deleteCheckpointRefs(repo: CheckpointRepo, refs: string[]): Promise<void> {
  const owned = refs.filter((ref) => ref.startsWith(CHECKPOINT_REF_ROOT))
  if (owned.length === 0) {
    return
  }
  await repo.git(['update-ref', '--stdin'], {
    stdin: owned.map((ref) => `delete ${ref}\n`).join('')
  })
}

/** Deletes all but the newest `keep` refs under `prefix`, plus any checkpoint older than `maxAgeMs`. */
export async function pruneCheckpointRefs(
  repo: CheckpointRepo,
  input: {
    prefix: string
    keep: number
    maxAgeMs: number
    now: number
    /** Never deleted here, whatever its date says (a clock that ran ahead must not prune the
     *  checkpoint just written). */
    protect?: string[]
  }
): Promise<string[]> {
  if (!input.prefix.startsWith(CHECKPOINT_REF_ROOT)) {
    throw new Error(`checkpoint prefixes live under ${CHECKPOINT_REF_ROOT}: ${input.prefix}`)
  }
  const overCount = (await listRefs(repo, input.prefix)).slice(input.keep).map((entry) => entry.ref)
  const cutoff = input.now - input.maxAgeMs
  const tooOld = (await listRefs(repo, CHECKPOINT_REF_ROOT))
    .filter((entry) => entry.committedAt < cutoff)
    .map((entry) => entry.ref)
  const kept = new Set(input.protect ?? [])
  const doomed = [...new Set([...overCount, ...tooOld])].filter((ref) => !kept.has(ref))
  await deleteCheckpointRefs(repo, doomed)
  return doomed
}
