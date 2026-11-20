// Disposable per-process folders; stdio children cannot reattach after a host restart, so a root's
// stale folders can be cleared on its first use.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

const wipes = new Map<string, Promise<void>>()

function removeFolder(path: string, logger?: StructuredAgentSessionLogger): Promise<void> {
  return rm(path, { recursive: true, force: true }).catch((error: unknown) =>
    logger?.warn('ACP agent temp folder not removed', { scope: 'acp-temp', path, error })
  )
}

function wipeRootOnce(root: string, logger?: StructuredAgentSessionLogger): Promise<void> {
  let wipe = wipes.get(root)
  if (!wipe) {
    wipe = removeFolder(root, logger)
    wipes.set(root, wipe)
  }
  return wipe
}

/** Clear crash leftovers on first use of a root, then isolate each process in a new folder. */
export async function acpRunFolder(
  root: string,
  logger?: StructuredAgentSessionLogger
): Promise<{ path: string; remove(): Promise<void> }> {
  await wipeRootOnce(root, logger)
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, 'run-'))
  return { path, remove: () => removeFolder(path, logger) }
}
