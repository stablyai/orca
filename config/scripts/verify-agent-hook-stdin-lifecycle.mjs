#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MANAGED_SCRIPTS = [
  ['antigravity-hook.sh', 'antigravity'],
  ['claude-hook.sh', 'claude'],
  ['codex-hook.sh', 'codex'],
  ['command-code-hook.sh', 'command-code'],
  ['copilot-hook.sh', 'copilot'],
  ['cursor-hook.sh', 'cursor'],
  ['devin-hook.sh', 'devin'],
  ['droid-hook.sh', 'droid'],
  ['gemini-hook.sh', 'gemini'],
  ['grok-hook.sh', 'grok'],
  ['kimi-hook.sh', 'kimi'],
  ['openclaude-hook.sh', 'claude']
]

const REQUIRED_JSON_STDOUT = new Set(['antigravity-hook.sh', 'copilot-hook.sh', 'gemini-hook.sh'])

function parseArgs(argv) {
  const result = { home: process.env.HOME ?? '', minMtime: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--home') {
      result.home = argv[index + 1] ?? ''
      index += 1
    } else if (value === '--min-mtime') {
      result.minMtime = Number(argv[index + 1] ?? 0)
      index += 1
    } else {
      throw new Error(['Unknown argument: ', value].join(''))
    }
  }
  if (!result.home) {
    throw new Error('Pass --home or set HOME to the isolated Electron home directory')
  }
  return result
}

function withoutOrcaEnvironment(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))),
    ...extra
  }
}

function runShell(command, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    const stdinErrors = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(['Timed out running: ', command.slice(0, 120)].join('')))
    }, 10_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.stdin.on('error', (error) => stdinErrors.push(error))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdinErrors,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
    child.stdin.end(payload)
  })
}

function assertSuccessfulWrite(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(
      [label, ' exited ', String(result.exitCode), ': ', result.stderr.slice(0, 500)].join('')
    )
  }
  if (result.stdinErrors.length > 0) {
    throw new Error(
      [
        label,
        ' produced stdin errors: ',
        result.stdinErrors.map((error) => error.message).join(', ')
      ].join('')
    )
  }
}

function assertProtocolStdout(fileName, stdout) {
  if (!REQUIRED_JSON_STDOUT.has(fileName)) {
    return
  }
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0]
  try {
    JSON.parse(firstLine)
  } catch {
    throw new Error([fileName, ' did not emit protocol JSON: ', stdout.slice(0, 200)].join(''))
  }
}

function readGeneratedScripts(home, minMtime) {
  const hooksDir = join(home, '.orca', 'agent-hooks')
  return MANAGED_SCRIPTS.map(([fileName, source]) => {
    const path = join(hooksDir, fileName)
    const stats = statSync(path)
    if (!stats.isFile()) {
      throw new Error([fileName, ' is not a regular file'].join(''))
    }
    try {
      accessSync(path, fsConstants.R_OK | fsConstants.X_OK)
    } catch {
      throw new Error([fileName, ' is not readable and executable'].join(''))
    }
    if (minMtime > 0 && stats.mtimeMs < minMtime) {
      throw new Error([fileName, ' predates the Electron launch'].join(''))
    }
    const body = readFileSync(path, 'utf8')
    const captureIndex = body.indexOf('payload=$(cat)')
    const firstExitIndex = body.indexOf('exit 0')
    if (captureIndex < 0 || firstExitIndex <= captureIndex) {
      throw new Error([fileName, ' can exit before capturing stdin'].join(''))
    }
    return { body, fileName, path, source }
  })
}

function findStrings(value, matches = []) {
  if (typeof value === 'string') {
    matches.push(value)
    return matches
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      findStrings(child, matches)
    }
    return matches
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      findStrings(child, matches)
    }
  }
  return matches
}

function nextRequest(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.removeListener('request', onRequest)
      reject(new Error('Generated hook did not reach the loopback server'))
    }, 8_000)
    const onRequest = (request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        clearTimeout(timeout)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{}')
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
          url: request.url
        })
      })
    }
    server.once('request', onRequest)
  })
}

async function verifyNoOpWrites(scripts, home, payload) {
  const commandCodeBin = mkdtempSync(join(tmpdir(), 'orca-hook-command-code-bin-'))
  symlinkSync('/bin/cat', join(commandCodeBin, 'cat'))
  try {
    for (const script of scripts) {
      const path =
        script.fileName === 'command-code-hook.sh'
          ? commandCodeBin
          : (process.env.PATH ?? '/usr/bin:/bin')
      const result = await runShell(
        ['/bin/sh ', JSON.stringify(script.path)].join(''),
        payload,
        withoutOrcaEnvironment({
          HOME: home,
          PATH: path,
          ORCA_AGENT_HOOK_ENDPOINT: ''
        })
      )
      assertSuccessfulWrite(result, [script.fileName, ' no-op'].join(''))
      assertProtocolStdout(script.fileName, result.stdout)
    }
  } finally {
    rmSync(commandCodeBin, { recursive: true, force: true })
  }
}

async function verifyClaudeDevinSkip(scripts, home, payload) {
  const claude = scripts.find((script) => script.fileName === 'claude-hook.sh')
  let unexpectedRequests = 0
  const server = createServer((_request, response) => {
    unexpectedRequests += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Claude skip verifier did not receive a TCP port')
    }
    const result = await runShell(
      ['/bin/sh ', JSON.stringify(claude.path)].join(''),
      payload,
      withoutOrcaEnvironment({
        DEVIN_PROJECT_DIR: join(home, 'devin-project'),
        HOME: home,
        ORCA_AGENT_HOOK_ENDPOINT: '',
        ORCA_AGENT_HOOK_PORT: String(address.port),
        ORCA_AGENT_HOOK_TOKEN: 'electron-verification-token',
        ORCA_PANE_KEY: 'electron-verification-pane'
      })
    )
    assertSuccessfulWrite(result, 'Claude Devin-import skip')
    if (unexpectedRequests !== 0) {
      throw new Error('Claude forwarded a hook imported by Devin')
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function verifyForwarding(scripts, home, payload) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Loopback verifier did not receive a TCP port')
    }
    for (const script of scripts) {
      const requestPromise = nextRequest(server)
      const result = await runShell(
        ['/bin/sh ', JSON.stringify(script.path)].join(''),
        payload,
        withoutOrcaEnvironment({
          HOME: home,
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'electron-verification-token',
          ORCA_PANE_KEY: 'electron-verification-pane',
          ORCA_TAB_ID: 'electron-verification-tab',
          ORCA_WORKTREE_ID: 'electron-verification-worktree',
          ORCA_AGENT_HOOK_ENV: 'test',
          ORCA_AGENT_HOOK_VERSION: '1',
          ORCA_ANTIGRAVITY_EVENT: 'PostInvocation',
          ORCA_COPILOT_HOOK_EVENT: 'PostToolUse'
        })
      )
      assertSuccessfulWrite(result, [script.fileName, ' forwarding'].join(''))
      assertProtocolStdout(script.fileName, result.stdout)
      const request = await requestPromise
      const form = new URLSearchParams(request.body)
      if (request.url !== ['/hook/', script.source].join('')) {
        throw new Error(
          [script.fileName, ' posted to ', String(request.url), ' instead of ', script.source].join(
            ''
          )
        )
      }
      if (request.headers['x-orca-agent-hook-token'] !== 'electron-verification-token') {
        throw new Error([script.fileName, ' lost the hook token header'].join(''))
      }
      if (form.get('payload') !== payload) {
        throw new Error([script.fileName, ' changed the forwarded payload'].join(''))
      }
      if (form.get('paneKey') !== 'electron-verification-pane') {
        throw new Error([script.fileName, ' changed the forwarded pane key'].join(''))
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// Why: rewrite from the path embedded in the installed command, not a
// reconstructed join(home, ...). That way missing/failing-script cases cannot
// silently re-run the real script if the install layout changes.
function rewriteLauncherScriptPath(command, nextPath) {
  const match = /if \[ -f '([^']+)'/.exec(command)
  if (!match) {
    throw new Error('Installed launcher command did not reference a quoted script path')
  }
  return command.replaceAll(match[1], nextPath)
}

async function verifyInstalledLauncher(home, payload) {
  const settingsPath = join(home, '.claude', 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const command = findStrings(settings).find(
    (value) => value.includes('claude-hook.sh') && value.includes('if [ -f ')
  )
  if (!command || !command.includes('] && [ -r ') || !command.includes('else cat >/dev/null')) {
    throw new Error('Electron did not install the guarded Claude launcher')
  }
  const scratch = mkdtempSync(join(tmpdir(), 'orca-hook-launcher-'))
  try {
    const missingPath = join(scratch, 'missing-hook.sh')
    const missingResult = await runShell(
      rewriteLauncherScriptPath(command, missingPath),
      payload,
      withoutOrcaEnvironment({ HOME: home })
    )
    assertSuccessfulWrite(missingResult, 'installed missing-script launcher')

    const failingPath = join(scratch, 'failing-hook.sh')
    writeFileSync(failingPath, '#!/bin/sh\ncat >/dev/null\nexit 7\n', 'utf8')
    chmodSync(failingPath, 0o755)
    const failingResult = await runShell(
      rewriteLauncherScriptPath(command, failingPath),
      payload,
      withoutOrcaEnvironment({ HOME: home })
    )
    if (failingResult.exitCode !== 7 || failingResult.stdinErrors.length > 0) {
      throw new Error('Installed launcher did not preserve a running script failure')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'shell',
    tool_output: 'x'.repeat(1_200_000)
  })
  const scripts = readGeneratedScripts(args.home, args.minMtime)
  await verifyNoOpWrites(scripts, args.home, payload)
  await verifyClaudeDevinSkip(scripts, args.home, payload)
  await verifyForwarding(scripts, args.home, payload)
  await verifyInstalledLauncher(args.home, payload)
  process.stdout.write(
    [
      JSON.stringify(
        {
          forwardingPayloadBytes: Buffer.byteLength(payload),
          claudeDevinSkipCases: 1,
          launcherCases: 2,
          noOpScripts: scripts.length,
          forwardedScripts: scripts.length,
          status: 'passed'
        },
        null,
        2
      ),
      '\n'
    ].join('')
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
