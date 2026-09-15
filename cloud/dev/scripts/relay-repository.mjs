import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single place naming the repository the Relay workflows live in and where their files sit. The
// public-repo copy moves this tree under cloud/, prefixes every workflow filename, and changes the
// owning repository, so only this module changes: nothing else may restate any of the three.
export const RELAY_GITHUB_REPOSITORY = 'stablyai/orca'

export const RELAY_WORKFLOW_FILE_PREFIX = 'cloud-'

// Where .github/workflows sits relative to this file. Workflows stay at the repository root while
// this tree moves under cloud/, so the depth changes at the copy even though the layout does not.
export const RELAY_WORKFLOW_DIRECTORY = new URL('../../../.github/workflows/', import.meta.url)

// Repository root, derived from the one directory above that already tracks the copy's depth.
export const RELAY_REPOSITORY_ROOT = new URL('../../', RELAY_WORKFLOW_DIRECTORY)

// Repository-relative path for a file in this tree. The prefix is 'cloud/' here and empty where
// the tree is the repository root, so callers naming git paths never restate the layout.
export function relayTreePath(suffix) {
  const prefix = relative(
    fileURLToPath(RELAY_REPOSITORY_ROOT),
    fileURLToPath(new URL('../../', import.meta.url))
  ).split(/[\\/]/).filter(Boolean)
  return [...prefix, suffix].join('/')
}

export function relayWorkflowFile(name) {
  return `${RELAY_WORKFLOW_FILE_PREFIX}${name}`
}

// Repository-relative path for a repository that renames its copies with `prefix`. Terraform's
// trusted prefix is a variable and need not be this checkout's, so callers rendering a
// workflow_ref from Terraform pass it in rather than assuming the local one.
export function prefixedRelayWorkflowPath(prefix, name) {
  return `.github/workflows/${prefix}${name}`
}

// Repository-relative path, the shape GitHub reports in workflow_ref and evidence payloads.
export function relayWorkflowPath(name) {
  return prefixedRelayWorkflowPath(RELAY_WORKFLOW_FILE_PREFIX, name)
}

export function relayWorkflowUrl(name) {
  return new URL(relayWorkflowFile(name), RELAY_WORKFLOW_DIRECTORY)
}

export function readRelayWorkflow(name) {
  return readFileSync(relayWorkflowUrl(name), 'utf8')
}
