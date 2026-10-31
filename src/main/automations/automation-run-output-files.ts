import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationRunOutput } from '../../shared/automation-run-result-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

// Kept beside the profile, not the workspace, so outputs outlive deleted workspaces.
export function automationRunOutputsRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'automation-run-outputs')
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

// Startup sweeping retries filesystem cleanup that fails after durable removal.
function removeOutputDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.warn('[automations] Failed to remove run outputs:', error)
  }
}

export function removeAutomationRunOutputs(
  runs: readonly Pick<AutomationRun, 'automationId' | 'id'>[],
  root = hasAppEnvironment() ? automationRunOutputsRoot() : null
): void {
  if (root) {
    for (const run of runs) {
      removeOutputDirectory(join(root, run.automationId, run.id))
    }
  }
}

export function removeAutomationOutputs(
  automationId: string,
  root = hasAppEnvironment() ? automationRunOutputsRoot() : null
): void {
  if (root) {
    removeOutputDirectory(join(root, automationId))
  }
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
export function sweepAutomationRunOutputs(
  runs: readonly AutomationRun[],
  root = hasAppEnvironment() ? automationRunOutputsRoot() : null
): void {
  if (!root) {
    return
  }
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
