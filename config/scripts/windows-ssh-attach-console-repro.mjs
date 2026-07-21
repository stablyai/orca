import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '..', '..')
const relayBuildDir = join(projectDir, 'out', 'relay', 'win32-x64')
const SENTINEL = Buffer.from('ORCA-RELAY v0.1.0 READY\n')
const HEADER_LENGTH = 13
const REGRESSION_TIMEOUT_MS = 15_000
const NODE_PTY_PATCH_FILENAME = 'node-pty-1.1.0-console-list-agent-patch.cjs'

if (process.platform !== 'win32') {
  console.log('SKIP: Windows ConPTY regression only runs on Windows.')
  process.exit(0)
}

const options = parseArgs(process.argv.slice(2))
const nodePath = resolve(options.node ?? process.execPath)
const nodePtyDir = resolve(options.nodePty ?? join(projectDir, 'node_modules', 'node-pty'))
const expectFailure = options.expect === 'attach-console-failure'

for (const required of [
  nodePath,
  nodePtyDir,
  join(relayBuildDir, 'relay.js'),
  join(relayBuildDir, '.version')
]) {
  if (!existsSync(required)) {
    throw new Error(`Required regression input is missing: ${required}`)
  }
}

const runDir = mkdtempSync(join(projectDir, '.issue-9586-relay-repro-'))
const relayPath = join(runDir, 'relay.js')
const stdoutLog = join(runDir, 'relay.log')
const stderrLog = join(runDir, 'relay.err.log')
const socketPath = `\\\\.\\pipe\\orca-issue-9586-${process.pid}-${Date.now()}`
let relayPid

try {
  prepareRelayTree(runDir, nodePtyDir)
  if (!options.skipRelayPatch) {
    applyPackagedNodePtyPatch(nodePath, runDir)
  }
  relayPid = launchRelayWithoutConsole({
    nodePath,
    relayPath,
    runDir,
    socketPath,
    stdoutLog,
    stderrLog
  })
  await waitForPipe(socketPath, 5_000)
  const observation = await exerciseRelayClient({
    nodePath,
    relayPath,
    runDir,
    socketPath,
    shell: options.shell
  })
  await waitForExit(relayPid, 8_000)

  const relayStdout = readIfPresent(stdoutLog)
  const relayStderr = readIfPresent(stderrLog)
  const attachConsoleFailed = relayStderr.includes('Error: AttachConsole failed')
  const installedNodePtyDir = join(runDir, 'node_modules', 'node-pty')
  const agentPath = join(installedNodePtyDir, 'lib', 'conpty_console_list_agent.js')
  const nativeBindingPath = join(
    installedNodePtyDir,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'conpty.node'
  )
  const summary = {
    node: observation.nodeVersion,
    nodePty: JSON.parse(readFileSync(join(nodePtyDir, 'package.json'), 'utf8')).version,
    shell: options.shell,
    relayPid,
    handshake: observation.handshake,
    ptySpawn: observation.ptySpawn,
    ptyShutdown: observation.ptyShutdown,
    relayAliveAfterPtyShutdown: observation.relayAliveAfterPtyShutdown,
    bridgeExit: observation.bridgeExit,
    relayPatchApplied: !options.skipRelayPatch,
    agentSha256: fileSha256(agentPath),
    nativeBindingPresent: existsSync(nativeBindingPath),
    attachConsoleFailed,
    relayExitedAfterClientDisconnect: !isProcessAlive(relayPid)
  }
  console.log(JSON.stringify(summary, null, 2))

  if (expectFailure !== attachConsoleFailed) {
    throw new Error(
      expectFailure
        ? `Expected the real console-list agent to fail AttachConsole. stderr:\n${relayStderr}`
        : `The real console-list agent failed AttachConsole. stderr:\n${relayStderr}`
    )
  }
  if (
    !observation.handshake ||
    !observation.ptySpawn ||
    !observation.ptyShutdown ||
    !observation.relayAliveAfterPtyShutdown
  ) {
    throw new Error(
      `Relay lifecycle did not complete. stdout:\n${relayStdout}\nstderr:\n${relayStderr}`
    )
  }
} finally {
  if (relayPid && isProcessAlive(relayPid)) {
    stopExactProcess(relayPid, relayPath)
  }
  rmSync(runDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

function parseArgs(args) {
  const parsed = { expect: 'clean', shell: 'cmd.exe', skipRelayPatch: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--skip-relay-patch') {
      parsed.skipRelayPatch = true
      continue
    }
    const value = args[index + 1]
    if (!value || !['--node', '--node-pty', '--expect', '--shell'].includes(flag)) {
      throw new Error(
        'Usage: node windows-ssh-attach-console-repro.mjs [--node PATH] [--node-pty DIR] [--shell PATH] [--skip-relay-patch] [--expect clean|attach-console-failure]'
      )
    }
    if (flag === '--node') {
      parsed.node = value
    }
    if (flag === '--node-pty') {
      parsed.nodePty = value
    }
    if (flag === '--expect') {
      parsed.expect = value
    }
    if (flag === '--shell') {
      parsed.shell = value
    }
    index++
  }
  if (!['clean', 'attach-console-failure'].includes(parsed.expect)) {
    throw new Error(`Unsupported expectation: ${parsed.expect}`)
  }
  return parsed
}

function prepareRelayTree(runDir, nodePtyDir) {
  for (const filename of [
    'relay.js',
    'relay-watcher.js',
    'managed-hook-runtime.js',
    NODE_PTY_PATCH_FILENAME,
    '.version'
  ]) {
    copyFileSync(join(relayBuildDir, filename), join(runDir, filename))
  }
  cpSync(nodePtyDir, join(runDir, 'node_modules', 'node-pty'), { recursive: true })
}

function applyPackagedNodePtyPatch(nodePath, runDir) {
  const result = spawnSync(nodePath, [join(runDir, NODE_PTY_PATCH_FILENAME)], {
    cwd: runDir,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`Packaged node-pty patch failed: ${result.stderr || result.stdout}`)
  }
}

function launchRelayWithoutConsole({
  nodePath,
  relayPath,
  runDir,
  socketPath,
  stdoutLog,
  stderrLog
}) {
  const relayArgs = [
    quoteWindowsArg(nodePath),
    quoteWindowsArg(relayPath),
    '--detached',
    '--grace-time',
    '5',
    '--sock-path',
    quoteWindowsArg(socketPath),
    '--endpoint-dir',
    quoteWindowsArg(join(runDir, 'endpoint')),
    '--log-file',
    quoteWindowsArg(stdoutLog),
    `1>${quoteWindowsArg(stdoutLog)}`,
    `2>${quoteWindowsArg(stderrLog)}`
  ].join(' ')
  const commandLine = `cmd.exe /d /s /c "${relayArgs}"`
  const script = [
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powerShellLiteral(commandLine)}; CurrentDirectory = ${powerShellLiteral(runDir)} }`,
    `if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue)" }`,
    '$result.ProcessId'
  ].join('; ')
  const launched = runPowerShell(script)
  const pid = Number(launched.stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not parse detached relay pid from: ${launched.stdout}`)
  }
  return pid
}

function exerciseRelayClient({ nodePath, relayPath, runDir, socketPath, shell }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bridge = spawn(nodePath, [relayPath, '--connect', '--sock-path', socketPath], {
      cwd: runDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const observation = {
      nodeVersion: readNodeVersion(nodePath),
      handshake: false,
      ptySpawn: false,
      ptyShutdown: false,
      relayAliveAfterPtyShutdown: false,
      bridgeExit: null
    }
    let stderr = ''
    let buffer = Buffer.alloc(0)
    let sentinelRead = false
    let outgoingSequence = 1
    let settled = false
    const timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for relay client lifecycle. stderr:\n${stderr}`)),
      REGRESSION_TIMEOUT_MS
    )

    bridge.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    bridge.on('error', finish)
    bridge.on('close', (code, signal) => {
      observation.bridgeExit = { code, signal }
      if (!settled && observation.relayAliveAfterPtyShutdown) {
        finish()
      } else if (!settled) {
        finish(new Error(`Relay bridge closed before lifecycle completed. stderr:\n${stderr}`))
      }
    })
    bridge.stdout.on('data', (data) => {
      try {
        buffer = Buffer.concat([buffer, data])
        if (!sentinelRead) {
          const sentinelIndex = buffer.indexOf(SENTINEL)
          if (sentinelIndex === -1) {
            return
          }
          buffer = buffer.subarray(sentinelIndex + SENTINEL.length)
          sentinelRead = true
          observation.handshake = true
          request(1, 'pty.spawn', {
            shellOverride: shell,
            cwd: projectDir,
            cols: 80,
            rows: 24,
            env: {}
          })
        }
        for (const message of drainMessages()) {
          if (message.id === 1) {
            throwResponseError(message)
            observation.ptySpawn = true
            request(2, 'pty.shutdown', { id: message.result.id, immediate: true })
          } else if (message.id === 2) {
            throwResponseError(message)
            observation.ptyShutdown = true
            request(3, 'relay.status', {})
          } else if (message.id === 3) {
            throwResponseError(message)
            observation.relayAliveAfterPtyShutdown = message.result.ptys.active === 0
            bridge.stdin.end()
          }
        }
      } catch (error) {
        finish(error)
      }
    })

    function request(id, method, params) {
      bridge.stdin.write(encodeRequestFrame({ id, method, params }, outgoingSequence++))
    }

    function drainMessages() {
      const messages = []
      while (buffer.length >= HEADER_LENGTH) {
        const type = buffer[0]
        const payloadLength = buffer.readUInt32BE(9)
        if (buffer.length < HEADER_LENGTH + payloadLength) {
          break
        }
        const payload = buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLength)
        buffer = buffer.subarray(HEADER_LENGTH + payloadLength)
        if (type === 1) {
          messages.push(JSON.parse(payload.toString('utf8')))
        }
      }
      return messages
    }

    function finish(error) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) {
        bridge.kill()
        rejectPromise(error)
      } else {
        resolvePromise(observation)
      }
    }
  })
}

function waitForPipe(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = createConnection(socketPath)
      let settled = false
      const retry = () => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()
        if (Date.now() >= deadline) {
          rejectPromise(new Error(`Detached relay did not listen on ${socketPath}`))
        } else {
          setTimeout(attempt, 50)
        }
      }
      socket.once('connect', () => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()
        resolvePromise()
      })
      socket.once('error', retry)
      socket.setTimeout(250, retry)
    }
    attempt()
  })
}

function encodeRequestFrame({ id, method, params }, sequence) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const header = Buffer.alloc(HEADER_LENGTH)
  header[0] = 1
  header.writeUInt32BE(sequence, 1)
  header.writeUInt32BE(0, 5)
  header.writeUInt32BE(payload.length, 9)
  return Buffer.concat([header, payload])
}

function throwResponseError(message) {
  if (message.error) {
    throw new Error(`Relay RPC failed: ${message.error.message}`)
  }
}

function readNodeVersion(nodePath) {
  return spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim()
}

function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise) => {
    const poll = () => {
      if (!isProcessAlive(pid) || Date.now() >= deadline) {
        resolvePromise()
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function isProcessAlive(pid) {
  const result = runPowerShell(
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' }`
  )
  return result.stdout.includes('ALIVE')
}

function stopExactProcess(pid, relayPath) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter ${powerShellLiteral(`ProcessId = ${pid}`)}`,
    `if ($process -and $process.CommandLine -like ${powerShellLiteral(`*${relayPath}*`)}) { Stop-Process -Id ${pid} -Force }`
  ].join('; ')
  runPowerShell(script)
}

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`PowerShell failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result
}

function quoteWindowsArg(value) {
  return `"${value.replaceAll('"', '\\"')}"`
}

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
