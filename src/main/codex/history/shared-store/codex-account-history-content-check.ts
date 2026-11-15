import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'
import {
  factsOf,
  inventoryCodexHistoryLeftBehind,
  fromManifestPath,
  readManifest,
  sameFacts,
  storeFileFacts,
  updateManifest,
  type ContentCheck,
  type LeftBehindRollout
} from './codex-account-history-cleanup-manifest'

async function contentSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  const raw = createReadStream(path, { highWaterMark: 1024 * 1024 })
  const digest = async (content: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of content) {
      hash.update(chunk)
    }
  }
  await (path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? pipeline(raw, createZstdDecompress(), digest)
    : pipeline(raw, digest))
  return hash.digest('hex')
}

async function checkContent(
  accountHome: string,
  storeHome: string,
  rollout: LeftBehindRollout
): Promise<ContentCheck | null> {
  if (!rollout.storePath) {
    return null
  }
  const store = await storeFileFacts(storeHome, rollout.storePath)
  if (!store) {
    return null
  }
  let sha256: string
  let storeSha256: string
  try {
    ;[sha256, storeSha256] = await Promise.all([
      contentSha256(fromManifestPath(accountHome, rollout.path)),
      contentSha256(fromManifestPath(storeHome, rollout.storePath))
    ])
  } catch (error) {
    // A corrupt `.zst` never matches; anything else (a moved file) is checked on a later pass.
    const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
    if (!code.startsWith('ZSTD_')) {
      return null
    }
    return { at: new Date().toISOString(), sameContent: false, sha256: '', store }
  }
  const home = await lstatIfPresent(fromManifestPath(accountHome, rollout.path))
  const homeFacts = home?.isFile()
    ? factsOf(accountHome, fromManifestPath(accountHome, rollout.path), home)
    : null
  if (
    !sameFacts(rollout, homeFacts) ||
    !sameFacts(store, await storeFileFacts(storeHome, store.path))
  ) {
    return null
  }
  return { at: new Date().toISOString(), sameContent: sha256 === storeSha256, sha256, store }
}

// Checkpoints rewrite the whole manifest, so they are spaced by time, not by count.
const SAVE_INTERVAL_MS = 30_000

/**
 * Rebuilds the home's left-behind inventory, then compares each unchecked rollout with its store
 * copy, saving progress as it goes. False when `shouldStop` cut it short.
 */
export async function checkCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
  shouldStop: () => boolean
}): Promise<boolean> {
  if (!(await readManifest(args.accountHome))) {
    return true
  }
  await inventoryCodexHistoryLeftBehind(args)
  const manifest = await readManifest(args.accountHome)
  if (!manifest || manifest === 'newer') {
    return true
  }
  const checks = new Map<string, { rollout: LeftBehindRollout; check: ContentCheck }>()
  const save = async (): Promise<void> => {
    const pending = new Map(checks)
    checks.clear()
    await updateManifest(args.accountHome, async (current) => {
      const base = current ?? manifest
      return {
        ...base,
        rollouts: base.rollouts.map((rollout) => {
          const checked = pending.get(rollout.path)
          // A pass meanwhile may have seen either file change; such a check is stale.
          return checked &&
            !rollout.check &&
            sameFacts(rollout, checked.rollout) &&
            rollout.storePath === checked.check.store.path
            ? { ...rollout, check: checked.check }
            : rollout
        })
      }
    })
  }
  let finished = true
  let savedAt = Date.now()
  for (const rollout of manifest.rollouts) {
    if (rollout.check) {
      continue
    }
    if (args.shouldStop()) {
      finished = false
      break
    }
    const check = await checkContent(args.accountHome, args.storeHome, rollout)
    if (check) {
      checks.set(rollout.path, { rollout, check })
    }
    if (checks.size > 0 && Date.now() - savedAt >= SAVE_INTERVAL_MS) {
      await save()
      savedAt = Date.now()
    }
  }
  if (checks.size > 0) {
    await save()
  }
  return finished
}
