import { extname, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { readArtifactFileWithinLimit } from '../../shared/artifact-file-read'
import { readFile } from 'node:fs/promises'
import {
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
  // The host bounds evidence; keep the tail, where errors usually end.
  const text = await readFile(resolve(cwd, path), 'utf8').catch(() => {
    throw new RuntimeClientError(
      'invalid_argument',
      'Evidence file was not found or is not a file.'
    )
  })
  return text.slice(-MAX_AUTOMATION_RUN_EVIDENCE_LENGTH)
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
    const title = getRequiredStringFlag(flags, 'title')
    const read = await readArtifactFileWithinLimit(path, MAX_AUTOMATION_RUN_OUTPUT_BYTES)
    if (read.status !== 'ok') {
      throw new RuntimeClientError(
        'invalid_argument',
        read.status === 'too-large'
          ? `Attached files are limited to ${MAX_AUTOMATION_RUN_OUTPUT_BYTES / 1024} KiB.`
          : read.status === 'empty'
            ? 'The file is empty.'
            : 'File was not found or is not a file.'
      )
    }
    await assertRunResultsSupported(client)
    const result = await client.call<{ runId: string; outputId: string }>(
      'automation.attachOutput',
      { title, format, content: read.content }
    )
    printResult(result, json, () => `Attached "${title}" to this run.`)
  }
}
