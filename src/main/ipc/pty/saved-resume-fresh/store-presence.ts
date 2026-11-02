import { dirname, basename, isAbsolute, join } from 'node:path'
import { getSystemCodexHomePath } from '../../../codex/codex-home-paths'
import { hasCustomCodexHomeOverrideForLaunch } from '../../../codex/codex-real-home-path'
import { isCodexHistorySharedAcrossAccounts } from '../../../codex-accounts/codex-history-sharing'
import {
  findStoreFile,
  newStoreReadBudget,
  statStoreFile,
  type StorePresence,
  type StoreReadBudget
} from './store-walk'
import { claudeStorePresence } from './claude-store-presence'
import { openCodeStorePresence } from './opencode-store-presence'
import type { SavedResumeStoreQuery } from './store-query'

const MAX_CONCURRENT_CHECKS = 2
const waiting: (() => void)[] = []
let running = 0

/** A slot before the check's deadline, or false; a released slot passes straight to the next waiter. */
function acquireCheckSlot(deadline: number): Promise<boolean> {
  if (running < MAX_CONCURRENT_CHECKS) {
    running += 1
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const granted = () => {
      clearTimeout(expiry)
      resolve(true)
    }
    const expiry = setTimeout(
      () => {
        waiting.splice(waiting.indexOf(granted), 1)
        resolve(false)
      },
      Math.max(0, deadline - Date.now())
    )
    waiting.push(granted)
  })
}

function releaseCheckSlot(): void {
  const next = waiting.shift()
  if (next) {
    next()
  } else {
    running -= 1
  }
}

/** found / missing / unknown for the conversation in the store this launch's agent reads. Only
 *  this launch's own store is read; a store another account or host keeps is never consulted.
 *  Every wait, queued or in a worker, ends by the check's deadline as unknown. */
export async function probeSavedResumeStore(query: SavedResumeStoreQuery): Promise<StorePresence> {
  const budget = newStoreReadBudget()
  if (!(await acquireCheckSlot(budget.deadline))) {
    return 'unknown'
  }
  try {
    const reported = query.providerSession.transcriptPath
    if (reported && isAbsolute(reported) && (await statStoreFile(reported)) === 'found') {
      return 'found'
    }
    return await readAgentStore(query, budget)
  } catch {
    return 'unknown'
  } finally {
    releaseCheckSlot()
  }
}

function readAgentStore(query: SavedResumeStoreQuery, budget: StoreReadBudget) {
  switch (query.agent) {
    case 'codex':
      return codexStorePresence(query, budget)
    case 'claude':
      return claudeStorePresence(query, budget)
    case 'opencode':
    case 'opencode2':
      return openCodeStorePresence(query, budget)
    case 'pi':
      return piStorePresence(query, budget)
    default:
      return Promise.resolve<StorePresence>('unknown')
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function codexStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  if (query.codexHome.verified) {
    return 'found'
  }
  // Shared history links in from other accounts in the background, with no completion proof.
  const bridged =
    !query.settings ||
    (isCodexHistorySharedAcrossAccounts(query.settings) &&
      query.settings.codexManagedAccounts.length > 0)
  if (bridged || hasCustomCodexHomeOverrideForLaunch(query.launchEnv)) {
    return 'unknown'
  }
  const home = query.codexHome.selected ?? getSystemCodexHomePath()
  // Reverting a thread adds `_<rollout>`; compressed rollouts still count as the conversation.
  const name = new RegExp(
    `-${escapeRegExp(query.providerSession.id)}(?:_[\\w-]+)?\\.jsonl(?:\\.zst)?$`,
    'i'
  )
  const matches = (entry: string): boolean => name.test(entry)
  const live = await findStoreFile(join(home, 'sessions'), 3, matches, budget)
  return live === 'missing'
    ? findStoreFile(join(home, 'archived_sessions'), 3, matches, budget, {
        absentRootIsEmpty: true
      })
    : live
}

/** Pi resumes the exact session file; a moved file is still the conversation within its store. */
async function piStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const path = query.providerSession.transcriptPath
  if (!path || !isAbsolute(path) || query.recipeArgs.includes('--session-dir')) {
    return 'unknown'
  }
  const exact = await statStoreFile(path)
  const sessionsRoot = [dirname(path), dirname(dirname(path))].find(
    (dir) => basename(dir) === 'sessions'
  )
  if (exact !== 'missing' || !sessionsRoot) {
    return exact === 'missing' ? 'unknown' : exact
  }
  const suffix = `_${query.providerSession.id}.jsonl`
  return findStoreFile(sessionsRoot, 1, (entry) => entry.endsWith(suffix), budget)
}
