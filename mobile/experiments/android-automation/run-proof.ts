import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { runProcess } from '../../../src/shared/child-process/run-process'
import { assertShellMutation, assertUnrelatedDenial } from './security-witnesses'
import { buildSnapshot } from '../../../src/main/browser/snapshot-engine'

const serial = process.env.ANDROID_SERIAL
assert(serial?.startsWith('emulator-'), 'Use a dedicated headless emulator')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(process.env.ORCA_AUTOMATION_PROOF_DEDICATED, '1')
const output = process.env.ORCA_AUTOMATION_PROOF_OUTPUT
assert(output, 'Set ORCA_AUTOMATION_PROOF_OUTPUT to an evidence directory')
const directory = resolve(output)
await mkdir(directory, { recursive: true })
const root = resolve('mobile/experiments/android-automation')
const app = 'dev.orca.automationproof'
const outsider = 'dev.orca.outsider'
const installed: string[] = []
const cleanup: { action: string; error?: string }[] = []
const evidence: Record<string, unknown> = { serial }
let forwardedPort: string | undefined
let failure: unknown

async function adbResult(...args: string[]) {
  return runProcess({
    program: process.env.ADB ?? 'adb',
    args: ['-s', serial ?? '', ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
}
async function adb(...args: string[]) {
  const result = await adbResult(...args)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  return result.stdout.trim()
}
async function waitForFile(packageName: string, filename: string) {
  const file = `/sdcard/Android/data/${packageName}/files/${filename}`
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const result = await adbResult('shell', 'cat', file)
    if (result.code === 0) {
      return JSON.parse(result.stdout)
    }
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${file}`)
}
async function start(mode: string) {
  await adb('shell', 'am', 'start', '-W', '-n', `${app}/.Launcher`, '--es', 'mode', mode)
  return waitForFile(app, 'evidence.json')
}

async function shellCdp(url: string) {
  const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 })
  let sequence = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    const entry = pending.get(message.id)
    if (!entry) {
      return
    }
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(JSON.stringify(message.error)))
    } else {
      entry.resolve(message.result)
    }
  })
  socket.on('error', (error) => {
    for (const entry of pending.values()) {
      entry.reject(error)
    }
    pending.clear()
  })
  try {
    await new Promise<void>((resolveOpen, reject) => {
      socket.once('open', resolveOpen)
      socket.once('error', reject)
    })
    async function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = ++sequence
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise((resolveReply, reject) => {
          pending.set(id, { resolve: resolveReply, reject })
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`CDP timeout: ${method}`))
          }, 10_000)
          socket.send(JSON.stringify({ id, method, params }))
        })
      } finally {
        clearTimeout(timer)
      }
    }
    evidence.shellMutation = await send('Runtime.evaluate', {
      expression: "window.adbAttached = 'shell-owned'; window.adbAttached",
      returnByValue: true
    })
    assertShellMutation(evidence.shellMutation)
    evidence.shellMutationReadback = await send('Runtime.evaluate', {
      expression: 'window.adbAttached',
      returnByValue: true
    })
    assertShellMutation(evidence.shellMutationReadback)
    const snapshot = await buildSnapshot(send)
    await writeFile(join(directory, 'desktop-snapshot.txt'), snapshot.snapshot)
    evidence.desktopSnapshot = { refs: snapshot.refs, snapshot: snapshot.snapshot }
    assert(snapshot.snapshot.includes('Customer'))
    assert(snapshot.snapshot.includes('Submit order'))
  } finally {
    socket.terminate()
  }
}

try {
  assert.equal(await adb('shell', 'getprop', 'sys.boot_completed'), '1')
  evidence.shellIdentity = await adb('shell', 'id')
  evidence.selinux = await adb('shell', 'getenforce')
  evidence.android = await adb('shell', 'getprop', 'ro.build.fingerprint')
  evidence.buildType = await adb('shell', 'getprop', 'ro.build.type')
  evidence.osDebuggable = await adb('shell', 'getprop', 'ro.debuggable')
  assert.equal(
    evidence.buildType,
    'user',
    'Use a production user image; userdebug forces WebView debugging'
  )
  assert.equal(evidence.osDebuggable, '0')
  for (const [module, packageName] of [
    ['app', app],
    ['outsider', outsider]
  ]) {
    assert.equal(
      await adb('shell', 'pm', 'list', 'packages', packageName),
      '',
      'Refusing pre-existing package'
    )
    await adb('install', join(root, module, 'build/outputs/apk/release', `${module}-release.apk`))
    installed.push(packageName)
  }
  const result = await start('cdp')
  evidence.inApp = result
  assert.equal(result.debuggable, false)
  assert.notEqual(result.pid, result.shellPid)
  assert.equal(result.completed, true, result.failure)
  assert.match(result.debugDisabledRejected, /Connection refused/)
  assert.match(result.liveDisableRejected, /Connection refused/)
  assert.equal(result.liveDisableDiscovery, undefined)
  assert(result.screenshotBytes > 1000, result.screenshotFailure)
  assert.equal(result.interaction.value, 'Orca agent 한글')
  const events = result.interaction.events
  assert(Array.isArray(events))
  assert(
    events.some(
      (event) => event.type === 'click' && event.target === 'submit' && event.trusted === true
    )
  )
  assert(events.some((event) => event.type === 'input' && event.trusted === true))
  assert(events.every((event) => event.trusted === true))
  for (const file of [
    'evidence.json',
    'ax-tree.json',
    ...(result.screenshotBytes ? ['cdp-screenshot.png'] : [])
  ]) {
    await adb('pull', `/sdcard/Android/data/${app}/files/${file}`, join(directory, file))
  }
  const runAs = await adbResult('shell', 'run-as', app, 'id')
  evidence.runAs = runAs
  assert.notEqual(runAs.code, 0)
  assert.match(runAs.stdout + runAs.stderr, /not debuggable/)
  evidence.socketDiscovery = (await adb('shell', 'cat', '/proc/net/unix'))
    .split('\n')
    .filter((line) => line.includes(result.socket))
  await adb(
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    `${outsider}/.Probe`,
    '--es',
    'socket',
    result.socket
  )
  const unrelated = await waitForFile(outsider, 'probe.json')
  evidence.unrelatedApp = unrelated
  assert.equal(result.socket, `webview_devtools_remote_${result.pid}`)
  assertUnrelatedDenial(unrelated, result.socket, result.uid)
  const port = await adb('forward', 'tcp:0', `localabstract:${result.socket}`)
  assert.match(port, /^\d+$/)
  forwardedPort = port
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000)
  })
  assert(response.ok)
  const pages = await response.json()
  evidence.shellDiscovery = pages
  assert(Array.isArray(pages))
  assert.equal(pages.length, 1)
  assert(typeof pages[0]?.webSocketDebuggerUrl === 'string')
  const url = new URL(pages[0].webSocketDebuggerUrl)
  url.host = `127.0.0.1:${port}`
  await shellCdp(url.toString())
  await adb('shell', 'am', 'force-stop', app)
  await adb('shell', 'rm', `/sdcard/Android/data/${app}/files/evidence.json`)
  const disabled = await start('off')
  evidence.disabledRestart = disabled
  assert.equal(disabled.completed, true)
  assert.match(disabled.debugDisabledRejected, /Connection refused/)
  assert.equal(disabled.debugDisabledDiscovery, undefined)
  const sockets = await adb('shell', 'cat', '/proc/net/unix')
  evidence.remainingDebugSockets = sockets
    .split('\n')
    .filter((line) => /webview_devtools_remote_/.test(line))
  assert.deepEqual(evidence.remainingDebugSockets, [])
  evidence.passed = true
} catch (error) {
  failure = error
  evidence.failure = error instanceof Error ? error.stack : String(error)
} finally {
  if (forwardedPort) {
    try {
      await adb('forward', '--remove', `tcp:${forwardedPort}`)
      cleanup.push({ action: `remove forward ${forwardedPort}` })
    } catch (error) {
      cleanup.push({ action: 'remove forward', error: String(error) })
    }
  }
  for (const packageName of installed.toReversed()) {
    try {
      await adb('uninstall', packageName)
      assert.equal(await adb('shell', 'pm', 'list', 'packages', packageName), '')
      cleanup.push({ action: `uninstall ${packageName}` })
    } catch (error) {
      cleanup.push({ action: `uninstall ${packageName}`, error: String(error) })
    }
  }
  evidence.cleanup = cleanup
  await writeFile(join(directory, 'run.json'), JSON.stringify(evidence, null, 2) + '\n')
}
if (failure || cleanup.some((entry) => entry.error)) {
  process.exitCode = 1
}
console.log(JSON.stringify({ passed: evidence.passed ?? false, directory, cleanup }))
