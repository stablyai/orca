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

function inspectNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const nodePtyDir = resolve(relayDir, 'node_modules', 'node-pty')
  const packageJsonPath = join(nodePtyDir, 'package.json')
  const agentPath = join(nodePtyDir, 'lib', 'conpty_console_list_agent.js')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (packageJson.version !== EXPECTED_NODE_PTY_VERSION) {
    throw new Error(
      `Refusing to patch node-pty ${packageJson.version}; expected ${EXPECTED_NODE_PTY_VERSION}`
    )
  }
  const source = readFileSync(agentPath, 'utf8')
  return { agentPath, source }
}

function assertPatchedNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const inspected = inspectNodePtyConsoleListAgent(relayDir)
  if (sourceSha256(inspected.source) !== PATCHED_SOURCE_SHA256) {
    throw new Error('node-pty ConPTY console-list fallback is not installed')
  }
}

function patchNodePtyConsoleListAgent(relayDir = process.cwd()) {
  const inspected = inspectNodePtyConsoleListAgent(relayDir)
  const sourceHash = sourceSha256(inspected.source)
  if (sourceHash === PATCHED_SOURCE_SHA256) {
    return
  }
  if (sourceHash !== ORIGINAL_SOURCE_SHA256) {
    throw new Error('Refusing to patch unexpected node-pty console-list agent source')
  }
  const patchedSource = inspected.source.replace(ORIGINAL_BODY, PATCHED_BODY)
  const temporaryPath = `${inspected.agentPath}.orca-patch-${process.pid}`
  // Why: a terminated remote install must leave either known source version recoverable on reconnect.
  try {
    writeFileSync(temporaryPath, patchedSource)
    renameSync(temporaryPath, inspected.agentPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  assertPatchedNodePtyConsoleListAgent(relayDir)
}

function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

if (require.main === module) {
  patchNodePtyConsoleListAgent()
}

module.exports = {
  assertPatchedNodePtyConsoleListAgent,
  patchNodePtyConsoleListAgent
}
