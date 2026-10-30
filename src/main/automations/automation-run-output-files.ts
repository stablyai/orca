import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationRunOutput } from '../../shared/automation-run-result-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

// Kept beside the profile, not the workspace, so outputs outlive deleted workspaces.
export function automationRunOutputsRoot(userDataPath: string): string {
  return join(userDataPath, 'automation-run-outputs')
}

function outputPath(
  root: string,
  run: Pick<AutomationRun, 'automationId' | 'id'>,
  output: Pick<AutomationRunOutput, 'id' | 'format'>
): string {
  return join(
    root,
    run.automationId,
    run.id,
    `${output.id}.${output.format === 'html' ? 'html' : 'md'}`
  )
}

export function writeAutomationRunOutputFile(
  root: string,
  run: Pick<AutomationRun, 'automationId' | 'id'>,
  output: Pick<AutomationRunOutput, 'id' | 'format'>,
  content: string
): void {
  mkdirSync(join(root, run.automationId, run.id), { recursive: true })
  writeFileAtomically(outputPath(root, run, output), content)
}

export function removeAutomationRunOutputFile(
  root: string,
  run: Pick<AutomationRun, 'automationId' | 'id'>,
  output: Pick<AutomationRunOutput, 'id' | 'format'>
): void {
  rmSync(outputPath(root, run, output), { force: true })
}

export function readAutomationRunOutputFile(
  root: string,
  run: Pick<AutomationRun, 'automationId' | 'id'>,
  output: Pick<AutomationRunOutput, 'id' | 'format'>
): string | null {
  try {
    return readFileSync(outputPath(root, run, output), 'utf8')
  } catch {
    return null
  }
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Delete output folders whose run was pruned or whose automation was deleted. */
export function sweepAutomationRunOutputs(root: string, runs: readonly AutomationRun[]): void {
  const retained = new Set(runs.map((run) => `${run.automationId}/${run.id}`))
  for (const automationId of listDirectories(root)) {
    const runIds = listDirectories(join(root, automationId))
    const kept = runIds.filter((runId) => retained.has(`${automationId}/${runId}`))
    for (const runId of runIds) {
      if (!kept.includes(runId)) {
        rmSync(join(root, automationId, runId), { recursive: true, force: true })
      }
    }
    if (kept.length === 0) {
      rmSync(join(root, automationId), { recursive: true, force: true })
    }
  }
}
