import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.258 (Claude Code)\n')
  process.exit(0)
}

const scenarioPath = process.env.ORCA_SDK_CONTRACT_SCENARIO_PATH
const reportPath = process.env.ORCA_SDK_CONTRACT_REPORT_PATH
// Every launch shares the report path, so a later one (e.g. model discovery) overwrites it; the
// log keeps each launch's reports, one JSON line per write.
const reportLogPath = process.env.ORCA_SDK_CONTRACT_REPORT_LOG_PATH

const report = {
  argv: process.argv.slice(1),
  execPath: process.execPath,
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.startsWith('ORCA_') || ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)
    )
  ),
  controlRequests: [],
  controlResponses: [],
  userMessages: [],
  descendantPid: null
}
const writeReport = () => {
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report))
  }
  if (reportLogPath) {
    appendFileSync(reportLogPath, `${JSON.stringify(report)}\n`)
  }
}
// Preserve launch evidence even if the scenario never finishes.
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
    kind === 'control_request' &&
    report.controlRequests.some((frame) => frame.request?.subtype === requestId)
  ) {
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
    settle('control_request', frame.request?.subtype)
    writeReport()
    if (process.env.ORCA_SDK_CONTRACT_IGNORE_CONTROL_REQUESTS) {
      return
    }
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: scenario.controlResponses?.[frame.request?.subtype] ?? {
          commands: [],
          models: []
        }
      }
    }
    // Write leading frames and the control reply together to exercise SDK delivery reordering.
    const leading = scenario.controlResponseLeadingFrames?.[frame.request?.subtype] ?? []
    process.stdout.write([...leading, response].map((line) => `${JSON.stringify(line)}\n`).join(''))
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

// Bound fixture lifetime if the SDK stops driving stdin.
setTimeout(
  () => process.exit(3),
  Number(process.env.ORCA_SDK_CONTRACT_TIMEOUT_MS ?? 20_000)
).unref()

for (const step of scenario.steps) {
  if (step.emit) {
    emit(step.emit)
  } else if (step.stderr !== undefined) {
    process.stderr.write(step.stderr)
  } else if (step.awaitUserMessage) {
    await waitFor('user')
  } else if (step.awaitControlRequest !== undefined) {
    await waitFor('control_request', step.awaitControlRequest)
  } else if (step.awaitControlResponse !== undefined) {
    await waitFor('control_response', step.awaitControlResponse)
  } else if (step.awaitFile) {
    const deadline = Date.now() + step.awaitFile.timeoutMs
    while (!existsSync(step.awaitFile.path)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for test acknowledgement: ${step.awaitFile.path}`)
      }
      await delay(10)
    }
  } else if (step.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, step.delayMs))
  } else if (step.exit !== undefined) {
    writeReport()
    process.exit(step.exit)
  }
}
writeReport()
process.exit(0)
