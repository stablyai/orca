import { spawnProcess } from '../shared/child-process/run-process'
import {
  collectMarkdownDocuments,
  MARKDOWN_DOCUMENT_GLOB
} from '../shared/node-markdown-document-listing'
import { buildRgArgsForQuickOpen } from '../shared/quick-open-filter'
import {
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  ripgrepMissingCwdError,
  RipgrepUnavailableError
} from '../shared/ripgrep-process-availability'
import { resolveRelayRipgrepCommand } from './relay-bundled-ripgrep'
import { expandTilde } from './context'

export async function listRelayMarkdownDocuments(rootPath: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const command = resolveRelayRipgrepCommand()
  if (!command) {
    throw new RipgrepUnavailableError()
  }
  const expandedRoot = expandTilde(rootPath)
  const child = spawnProcess({
    program: command,
    args: [
      '--type-add',
      `orcamarkdown:${MARKDOWN_DOCUMENT_GLOB}`,
      '--type',
      'orcamarkdown',
      ...buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: true
      }).ignoredPass
    ],
    cwd: expandedRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    return await collectMarkdownDocuments(child, expandedRoot, false, signal, {
      allowPartialListing: true
    })
  } catch (error) {
    signal?.throwIfAborted()
    if (
      !isTransientRipgrepSpawnError(error) &&
      isRipgrepUnavailableExit(child, child.exitCode, child.signalCode, {
        classifyNativeLauncherExit: true
      })
    ) {
      throw (await isRipgrepSpawnCwdUsable(expandedRoot))
        ? new RipgrepUnavailableError()
        : ripgrepMissingCwdError(expandedRoot)
    }
    throw error
  }
}
