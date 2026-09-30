// Scripted stand-in for the Claude Code CLI, driven by the SDK contract-pin
// tests. It speaks just enough stream-json to satisfy the SDK: it answers every
// inbound control_request with a success control_response, records everything it
// observes to a report file, and plays back the steps listed in a scenario file.
//
// Env contract (set by the test):
//   ORCA_SDK_CONTRACT_SCENARIO_PATH — JSON file
//     { steps: Step[], controlResponses?: { [subtype]: <response> } } where a Step is
//     { emit: <frame> } | { awaitUserMessage: true } | { stderr: <text> } |
//     { awaitControlResponse: <request_id> } | { delayMs: <n> } | { exit: <code> }
//   ORCA_SDK_CONTRACT_REPORT_PATH — where argv/env observations are written
//   ORCA_SDK_CONTRACT_IGNORE_SIGTERM — trap SIGTERM/SIGINT and outlive stdin close
//   ORCA_SDK_CONTRACT_IGNORE_CONTROL_REQUESTS — record control requests but never answer
//   ORCA_SDK_CONTRACT_DESCENDANT — fork an idle grandchild and report its pid
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const scenarioPath = process.env.ORCA_SDK_CONTRACT_SCENARIO_PATH
const reportPath = process.env.ORCA_SDK_CONTRACT_REPORT_PATH

const report = {
  argv: process.argv.slice(1),
  execPath: process.execPath,
  controlRequests: [],
  controlResponses: [],
  userMessages: [],
  descendantPid: null
}
const writeReport = () => {
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report))
  }
}
// Written immediately so a test can prove which script the SDK executed even if
// the session dies before the scenario completes.
writeReport()

const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { steps: [] }

if (process.env.ORCA_SDK_CONTRACT_IGNORE_SIGTERM) {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
  setInterval(() => {}, 1_000_000)
}
if (process.env.ORCA_SDK_CONTRACT_DESCENDANT) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], {
    stdio: 'ignore'
  })
  descendant.unref()
  report.descendantPid = descendant.pid ?? null
  writeReport()
}

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)

const waiters = []
const settle = (kind, requestId) => {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i]
    if (
      waiter.kind === kind &&
      (waiter.requestId === undefined || waiter.requestId === requestId)
    ) {
      waiters.splice(i, 1)
      waiter.resolve()
    }
  }
}
const waitFor = (kind, requestId) => {
  if (kind === 'user' && report.userMessages.length > 0) {
    return Promise.resolve()
  }
  if (
    kind === 'control_response' &&
    report.controlResponses.some((frame) => frame.response?.request_id === requestId)
  ) {
    return Promise.resolve()
  }
  return new Promise((resolve) => waiters.push({ kind, requestId, resolve }))
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame.type === 'control_request') {
    report.controlRequests.push(frame)
    writeReport()
    if (process.env.ORCA_SDK_CONTRACT_IGNORE_CONTROL_REQUESTS) {
      return
    }
    emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: scenario.controlResponses?.[frame.request?.subtype] ?? {
          commands: [],
          models: []
        }
      }
    })
    return
  }
  if (frame.type === 'control_response') {
    report.controlResponses.push(frame)
    writeReport()
    settle('control_response', frame.response?.request_id)
    return
  }
  if (frame.type === 'user') {
    report.userMessages.push(frame)
    writeReport()
    settle('user')
  }
})

// Never outlive a wedged test: the readline subscription would otherwise hold
// this process open forever if the SDK side stops driving the scenario.
setTimeout(() => process.exit(3), 20_000).unref()

for (const step of scenario.steps) {
  if (step.emit) {
    emit(step.emit)
  } else if (step.stderr !== undefined) {
    process.stderr.write(step.stderr)
  } else if (step.awaitUserMessage) {
    await waitFor('user')
  } else if (step.awaitControlResponse !== undefined) {
    await waitFor('control_response', step.awaitControlResponse)
  } else if (step.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, step.delayMs))
  } else if (step.exit !== undefined) {
    // A CLI that refuses to start: leave with its own status, stderr already written.
    writeReport()
    process.exit(step.exit)
  }
}
writeReport()
process.exit(0)
