import { basename, extname, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import { open } from 'node:fs/promises'
import {
  AUTOMATION_RUN_OUTPUT_TOO_LARGE_MESSAGE,
  MAX_AUTOMATION_RUN_OUTPUT_REQUEST_BYTES,
  MAX_AUTOMATION_RUN_EVIDENCE_LENGTH,
  MAX_AUTOMATION_RUN_OUTPUT_BYTES
} from '../../shared/automation-run-results'
import type { AutomationRunOutputFormat } from '../../shared/automation-run-result-types'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  AUTOMATION_RUN_RESULTS_RUNTIME_CAPABILITY,
  AUTOMATION_RUN_RESULTS_UPDATE_REQUIRED_MESSAGE
} from '../../shared/automation-runtime-capabilities'

// Older hosts lack these methods; say so instead of a bare method_not_found.
async function assertRunResultsSupported(client: RuntimeClient): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AUTOMATION_RUN_RESULTS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      AUTOMATION_RUN_RESULTS_UPDATE_REQUIRED_MESSAGE
    )
  }
}

function outputFormat(path: string): AutomationRunOutputFormat | null {
  const extension = extname(path).toLowerCase()
  return ['.html', '.htm'].includes(extension)
    ? 'html'
    : ['.md', '.markdown'].includes(extension)
      ? 'markdown'
      : null
}

async function readEvidence(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<string | undefined> {
  const path = getOptionalStringFlag(flags, 'evidence-file')
  if (!path) {
    return getOptionalStringFlag(flags, 'evidence')
  }
  if (getOptionalStringFlag(flags, 'evidence')) {
    throw new RuntimeClientError('invalid_argument', 'Use --evidence or --evidence-file, not both.')
  }
  // Keep only the tail, where errors usually end; logs can be far larger than the bound.
  const handle = await open(resolve(cwd, path), 'r').catch(() => null)
  const size = handle ? await handle.stat().then((stats) => (stats.isFile() ? stats.size : -1)) : -1
  if (!handle || size < 0) {
    await handle?.close()
    throw new RuntimeClientError(
      'invalid_argument',
      'Evidence file was not found or is not a file.'
    )
  }
  try {
    const length = Math.min(size, MAX_AUTOMATION_RUN_EVIDENCE_LENGTH)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    // A cut multi-byte character decodes as U+FFFD; drop it rather than send it.
    return buffer.toString('utf8').replace(/^\uFFFD+/, '')
  } finally {
    await handle.close()
  }
}

export const AUTOMATION_RUN_RESULT_HANDLERS: Record<string, CommandHandler> = {
  'automations warn': async ({ flags, client, cwd, json }) => {
    const resolveWarning = flags.get('resolve') === true
    const message = getOptionalStringFlag(flags, 'message')
    if (!resolveWarning && !message) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --message')
    }
    await assertRunResultsSupported(client)
    const result = await client.call<{ runId: string }>('automation.reportWarning', {
      key: getRequiredStringFlag(flags, 'key'),
      message,
      ...(resolveWarning
        ? { resolve: true }
        : {
            impact: getOptionalStringFlag(flags, 'impact'),
            evidence: await readEvidence(flags, cwd)
          })
    })
    printResult(result, json, () =>
      resolveWarning ? 'Warning resolved for this run.' : 'Warning recorded for this run.'
    )
  },
  'automations fail': async ({ flags, client, json }) => {
    await assertRunResultsSupported(client)
    const result = await client.call<{ runId: string }>('automation.reportFailure', {
      message: getRequiredStringFlag(flags, 'message')
    })
    printResult(
      result,
      json,
      () => 'Failure recorded. Orca marks this run failed when the agent finishes.'
    )
  },
  'automations attach': async ({ flags, client, cwd, json }) => {
    const path = resolve(cwd, getRequiredStringFlag(flags, 'file'))
    const format = outputFormat(path)
    if (!format) {
      throw new RuntimeClientError('invalid_argument', 'Attach an .html or .md file.')
    }
    const title = getOptionalStringFlag(flags, 'title') ?? basename(path, extname(path))
    const read = await readArtifactFileWithinLimit(path, MAX_AUTOMATION_RUN_OUTPUT_BYTES)
    if (read.status !== 'ok') {
      throw new RuntimeClientError(
        'invalid_argument',
        read.status === 'too-large'
          ? AUTOMATION_RUN_OUTPUT_TOO_LARGE_MESSAGE
          : read.status === 'empty'
            ? 'The file is empty.'
            : 'File was not found or is not a file.'
      )
    }
    const request = { title, format, content: read.content }
    if (
      Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_AUTOMATION_RUN_OUTPUT_REQUEST_BYTES
    ) {
      throw new RuntimeClientError('invalid_argument', AUTOMATION_RUN_OUTPUT_TOO_LARGE_MESSAGE)
    }
    await assertRunResultsSupported(client)
    const result = await client.call<{ runId: string; outputId: string }>(
      'automation.attachOutput',
      request
    )
    printResult(result, json, () => `Attached "${title}" to this run.`)
  }
}
