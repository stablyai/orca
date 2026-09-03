import { readFileSync } from 'node:fs'

// Single place naming the repository the Relay workflows live in and where their files sit. The
// public-repo copy moves this tree under cloud/, prefixes every workflow filename, and changes the
// owning repository, so only this module changes: nothing else may restate any of the three.
export const RELAY_GITHUB_REPOSITORY = 'stablyai/orca'

export const RELAY_WORKFLOW_FILE_PREFIX = 'cloud-'

// Where .github/workflows sits relative to this file. Workflows stay at the repository root while
// this tree moves under cloud/, so the depth changes at the copy even though the layout does not.
export const RELAY_WORKFLOW_DIRECTORY = new URL('../../../.github/workflows/', import.meta.url)

export function relayWorkflowFile(name) {
  return `${RELAY_WORKFLOW_FILE_PREFIX}${name}`
}

// Repository-relative path, the shape GitHub reports in workflow_ref and evidence payloads.
export function relayWorkflowPath(name) {
  return `.github/workflows/${relayWorkflowFile(name)}`
}

export function relayWorkflowUrl(name) {
  return new URL(relayWorkflowFile(name), RELAY_WORKFLOW_DIRECTORY)
}

export function readRelayWorkflow(name) {
  return readFileSync(relayWorkflowUrl(name), 'utf8')
}
