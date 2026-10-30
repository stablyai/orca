import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

/** Unknown fields can be ignored by older servers, so validate the exact executable before forking. */
export async function requireCodexForkCutSupport(launch: CodexStructuredLaunch): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-codex-fork-schema-'))
  try {
    const generated = await runProcess({
      program: launch.command,
      args: [...launch.args, 'generate-json-schema', '--experimental', '--out', directory],
      cwd: launch.cwd,
      env: resolveProviderChildEnv(launch, process.env),
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024
    })
    if (generated.code !== 0 || generated.timedOut) {
      throw new Error('schema unavailable')
    }
    const schema = readCodexJournalRecord(
      JSON.parse(await readFile(join(directory, 'v2', 'ThreadForkParams.json'), 'utf8'))
    )
    const properties = readCodexJournalRecord(schema.properties)
    if (!properties.lastTurnId || !properties.deferGoalContinuation) {
      throw new Error('cut unavailable')
    }
  } catch {
    throw new Error(
      'This Codex version cannot safely branch through a selected turn. Update Codex and try again.'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
