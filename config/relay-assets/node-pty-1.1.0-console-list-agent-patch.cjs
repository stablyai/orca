const { createHash } = require('node:crypto')
const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const EXPECTED_NODE_PTY_VERSION = '1.1.0'
const ORIGINAL_SOURCE_SHA256 = '0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52'
const PATCHED_SOURCE_SHA256 = '84df20cfe711a88d2bef35078615c58a6ce14f39348a4aef40e852b854dcd857'
const ORIGINAL_BODY = 'var consoleProcessList = getConsoleProcessList(shellPid);'
const PATCHED_BODY = `var consoleProcessList;
try {
    consoleProcessList = getConsoleProcessList(shellPid);
}
catch (_a) {
    // Why: AttachConsole can fail without a Win32 console; use node-pty's timeout fallback immediately.
    consoleProcessList = [shellPid];
}`

// Distinct, catchable outcomes so the deploy path can proceed on drift instead of hard-failing.
// Fail-OPEN posture (audit follow-up to PR #9638): if the freshly npm-installed source is neither
// the recognized ORIGINAL nor PATCHED sha, we REFUSE to mutate it (the sha gate stays intact) and
// run node-pty unpatched. That loses only the Windows ConPTY `AttachConsole`-failure try/catch
// fallback — a functionality degradation, NOT a security bypass. We never string-replace or mark
// an unrecognized/foreign source as patched.
const PATCH_OUTCOME = Object.freeze({
  PATCHED: 'patched',
  ALREADY_PATCHED: 'already-patched',
  UNPATCHED_ORIGINAL: 'unpatched-original',
  SKIPPED_UNEXPECTED_SOURCE: 'skipped-unexpected-source',
  SKIPPED_UNEXPECTED_VERSION: 'skipped-unexpected-version'
})

function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function readNodePtyConsoleListAgent(relayDir) {
  const nodePtyDir = resolve(relayDir, 'node_modules', 'node-pty')
  const packageJsonPath = join(nodePtyDir, 'package.json')
  const agentPath = join(nodePtyDir, 'lib', 'conpty_console_list_agent.js')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const source = readFileSync(agentPath, 'utf8')
  return { agentPath, source, version: packageJson.version }
}

// Classify the installed console-list agent WITHOUT mutating it and WITHOUT throwing on drift.
// Throws only if node-pty itself is absent/unreadable — that is a genuine native-deps failure the
// caller detects via require("node-pty"), not a patch concern.
function classifyNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const read = readNodePtyConsoleListAgent(relayDir)
  const sha256 = sourceSha256(read.source)
  const base = {
    agentPath: read.agentPath,
    source: read.source,
    version: read.version,
    sha256,
    sha256Prefix: sha256.slice(0, 12)
  }
  // Version drift can only come from an internal pin edit that forgot to bump this file's
  // EXPECTED_NODE_PTY_VERSION (external registry drift keeps version 1.1.0 and hits the source path).
  // Degrade rather than brick; the distinct outcome keeps the pin-drift visible in telemetry.
  if (read.version !== EXPECTED_NODE_PTY_VERSION) {
    return { ...base, outcome: PATCH_OUTCOME.SKIPPED_UNEXPECTED_VERSION }
  }
  if (sha256 === PATCHED_SOURCE_SHA256) {
    return { ...base, outcome: PATCH_OUTCOME.ALREADY_PATCHED }
  }
  if (sha256 === ORIGINAL_SOURCE_SHA256) {
    return { ...base, outcome: PATCH_OUTCOME.UNPATCHED_ORIGINAL }
  }
  return { ...base, outcome: PATCH_OUTCOME.SKIPPED_UNEXPECTED_SOURCE }
}

function isPatchSkippedOutcome(outcome) {
  return (
    outcome === PATCH_OUTCOME.SKIPPED_UNEXPECTED_SOURCE ||
    outcome === PATCH_OUTCOME.SKIPPED_UNEXPECTED_VERSION
  )
}

function assertPatchedNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const read = readNodePtyConsoleListAgent(relayDir)
  if (sourceSha256(read.source) !== PATCHED_SOURCE_SHA256) {
    throw new Error('node-pty ConPTY console-list fallback is not installed')
  }
}

// Returns the outcome instead of throwing on drift so the SSH relay deploy can degrade (run
// unpatched) rather than brick. Known-original source is still patched via the atomic
// temp-file+rename write and re-asserted against PATCHED_SOURCE_SHA256 (unchanged happy path).
function patchNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const classified = classifyNodePtyConsoleListAgent(relayDir)
  if (classified.outcome === PATCH_OUTCOME.ALREADY_PATCHED) {
    return classified
  }
  if (isPatchSkippedOutcome(classified.outcome)) {
    // Fail-OPEN: never mutate source we don't recognize; caller runs node-pty unpatched + reports.
    return classified
  }
  const patchedSource = classified.source.replace(ORIGINAL_BODY, PATCHED_BODY)
  const temporaryPath = `${classified.agentPath}.orca-patch-${process.pid}`
  // Why: a terminated remote install must leave either known source version recoverable on reconnect.
  try {
    writeFileSync(temporaryPath, patchedSource)
    renameSync(temporaryPath, classified.agentPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  assertPatchedNodePtyConsoleListAgent(relayDir)
  return { ...classified, outcome: PATCH_OUTCOME.PATCHED, sha256: PATCHED_SOURCE_SHA256 }
}

if (require.main === module) {
  // Fail-OPEN on drift: exit 0 so the remote install command does not abort the whole deploy.
  // The deploy probe re-detects the skip and emits telemetry on the Orca side (no sink here).
  const result = patchNodePtyConsoleListAgent()
  if (isPatchSkippedOutcome(result.outcome)) {
    console.warn(
      `[orca-relay] node-pty ConPTY console-list patch skipped (${result.outcome}); running unpatched. ` +
        `sha=${result.sha256Prefix} version=${result.version}`
    )
  }
}

module.exports = {
  PATCH_OUTCOME,
  assertPatchedNodePtyConsoleListAgent,
  classifyNodePtyConsoleListAgent,
  isPatchSkippedOutcome,
  patchNodePtyConsoleListAgent
}
