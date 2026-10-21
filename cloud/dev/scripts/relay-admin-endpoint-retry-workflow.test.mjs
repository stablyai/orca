import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { relayWorkflowUrl } from './relay-repository.mjs'

const WORKFLOWS = [
  'deploy-relay-production-same-cap-job.yml',
  'operate-relay-production-rehome-job.yml'
]

function workflow(name) {
  return readFileSync(fileURLToPath(relayWorkflowUrl(name)), 'utf8')
}

const VERIFY_STEP = 'name: Verify new incarnation, exact image, protocol, and durable safety'
const STALL_WINDOW = 'local out="${RUNNER_TEMP}/$1.json" window=60 delay=5 status'

function verifyStep() {
  return workflow('deploy-relay-production-same-cap-job.yml')
    .split(VERIFY_STEP)[1]
    .split('\n      - name:')[0]
}

function verifyAdminPost() {
  const step = verifyStep()
  const start = step.indexOf('admin_post() {')
  return step.slice(start, step.indexOf('\n          }', start) + '\n          }'.length)
}

// curl 7.81 (the Ubuntu 22.04 runners) never retries under --fail-with-body, so the
// remaining --retry flags are inert and only the verify loop below really retries.
// What holds for every admin curl: it is bounded and never retries a final 4xx.
test('every admin curl is bounded and never retries a final 4xx', () => {
  for (const name of WORKFLOWS) {
    for (const invocation of workflow(name).split(/\bcurl\b/).slice(1)) {
      const flags = invocation.split('\n          }')[0]
      assert.match(flags, /--max-time 30/, name)
      // --retry-all-errors would also retry 401, 403, and 409, which are final.
      assert.doesNotMatch(flags, /--retry-all-errors/, name)
    }
  }
})

test('every retried admin request captures only the final attempt body', () => {
  const job = workflow('deploy-relay-production-same-cap-job.yml')
  // --fail-with-body writes every failed attempt to stdout, so a retried
  // request must land in a file curl truncates per attempt.
  assert.match(job, /--output "\$\{out\}"/)
  assert.equal(job.split('admin_post() {').length - 1, 2)
  for (const call of [
    /CURRENT_RUNTIME="\$\(admin_post current-runtime/,
    /CURRENT_DIRECTOR_STATUS="\$\(admin_post current-cell-status/,
    /TARGET_RUNTIME="\$\(admin_post target-runtime/,
    /TARGET_DIRECTOR_STATUS="\$\(admin_post target-cell-status/
  ]) assert.match(job, call)
  // The verify loop captures only the status code; its body goes to the file.
  assert.doesNotMatch(job.replace(verifyAdminPost(), ''), /\$\(curl /)
})

// c18, 2026-10-07 18:49Z: a DB stall made the fresh cell answer 503 "no healthy upstream";
// three 2 s retries gave up and the cell was healthy 16 s later.
// 60 s covers a 7 s stall, 16 s readiness grace and two 10 s LB health checks.
test('the post-roll verify outlasts one DB stall and its health-check recovery', () => {
  assert.ok(verifyAdminPost().includes(STALL_WINDOW))
  assert.match(verifyAdminPost(), /--max-time 30/)
})

// Runs the step's own admin_post, with its retry clock scaled down twelve-fold.
async function runVerifyAdminPost(respond) {
  const scaled = verifyAdminPost().replace('window=60 delay=5', 'window=5 delay=1')
  assert.notEqual(scaled, verifyAdminPost())
  let calls = 0
  const startedAt = Date.now()
  const server = createServer((request, response) => {
    calls += 1
    const { status, body, drop } = respond(Date.now() - startedAt)
    if (drop) return void request.socket.destroy()
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const runnerTemp = mkdtempSync(join(tmpdir(), 'relay-verify-admin-post-'))
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/admin/runtime-status`
    const child = spawn(
      'bash',
      ['-euo', 'pipefail', '-c', `${scaled}\nadmin_post target-runtime "${url}" '{"v":1}'`],
      { env: { ...process.env, RUNNER_TEMP: runnerTemp, ORCA_RELAY_ADMIN_ID_TOKEN: 't' } }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve) => child.on('close', resolve))
    return { code, stdout, stderr, calls, elapsedMs: Date.now() - startedAt }
  } finally {
    server.close()
    rmSync(runnerTemp, { recursive: true, force: true })
  }
}

const UNHEALTHY = { status: 503, body: 'no healthy upstream' }

test('the verify read recovers when the cell comes back inside the retry window', async () => {
  const result = await runVerifyAdminPost((elapsedMs) =>
    elapsedMs < 2_500 ? UNHEALTHY : { status: 200, body: '{"ok":true}' }
  )
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '{"ok":true}')
  // The old three-retry budget would have given up here.
  assert.ok(result.calls > 3, `calls ${result.calls}`)
})

test('the verify read still fails a cell that stays down past the window', async () => {
  const result = await runVerifyAdminPost(() => UNHEALTHY)
  assert.notEqual(result.code, 0)
  assert.ok(result.elapsedMs >= 3_000, `gave up after ${result.elapsedMs} ms: ${result.stderr}`)
  assert.ok(result.elapsedMs < 8_000, `bounded at ${result.elapsedMs} ms`)
})

test('the verify read fails a final 4xx without waiting out the window', async () => {
  const result = await runVerifyAdminPost(() => ({ status: 409, body: '{"error":"generation"}' }))
  assert.notEqual(result.code, 0)
  assert.equal(result.calls, 1)
})

test('a final connection failure does not report the previous attempt body', async () => {
  const result = await runVerifyAdminPost((elapsedMs) => (elapsedMs < 1_000 ? UNHEALTHY : { drop: true }))
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /admin_post target-runtime: HTTP 000/)
  assert.doesNotMatch(result.stderr, /no healthy upstream/)
})
