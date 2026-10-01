/**
 * `relay.js --orca-runtime-selftest <nonce>`: prove this runtime can load the shipped
 * node-pty binding and open a PTY before a client launches a daemon on it (design D5).
 *
 * Why a separate process run rather than trusting the daemon's first spawn: a runtime
 * that cannot load the addon must be refused before a daemon holds the version dir, so
 * the client can still choose another runtime for that directory.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type * as NodePty from 'node-pty'
import { detectNativeHostAbi } from '../main/orcad/native-host-abi'
import {
  RELAY_RUNTIME_SELF_TEST_PREFIX,
  type RelayRuntimeSelfTestReport
} from '../shared/relay-runtime-self-test-report'
import { describeRelayRuntime } from './relay-runtime-identity'
import { relayBundledConptyPaths } from './relay-windows-conpty'

const PTY_EXIT_TIMEOUT_MS = 10_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ptyBindingPath(nodePtyDir: string, platform: NodeJS.Platform): string | null {
  const binding = platform === 'win32' ? 'conpty.node' : 'pty.node'
  for (const dir of ['build/Release', 'build/Debug']) {
    const candidate = join(nodePtyDir, dir, binding)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function openAndClosePty(pty: typeof NodePty, platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const common = { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd() }
    const child =
      platform === 'win32'
        ? // Why the bundled DLL: it is the ConPTY a pinned relay's terminals run on.
          pty.spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'exit 0'], {
            ...common,
            env: { ...process.env },
            useConptyDll: true
          })
        : pty.spawn('/bin/sh', ['-c', 'exit 0'], {
            ...common,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
          })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`the PTY child did not exit within ${PTY_EXIT_TIMEOUT_MS / 1000}s`))
    }, PTY_EXIT_TIMEOUT_MS)
    child.onExit(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function runRelayRuntimeSelfTest(
  nonce: string,
  nodePtyDir: string = join(__dirname, 'node_modules', 'node-pty'),
  platform: NodeJS.Platform = process.platform
): Promise<RelayRuntimeSelfTestReport> {
  const abi = detectNativeHostAbi()
  const base = {
    nonce,
    node: process.version,
    napi: process.versions.napi ?? null,
    glibcVersionRuntime: abi.glibcVersion,
    runtime: describeRelayRuntime().kind
  }
  const binding = ptyBindingPath(nodePtyDir, platform)
  if (!binding) {
    return { ...base, ok: false, stage: 'load', error: `no PTY binding under ${nodePtyDir}` }
  }
  if (platform === 'win32') {
    // The upload completed, so a file gone now was removed on the host (AV quarantine).
    const missing = relayBundledConptyPaths(nodePtyDir).find((path) => !existsSync(path))
    if (missing) {
      return {
        ...base,
        ok: false,
        stage: 'load',
        error: `bundled ConPTY file missing after upload: ${missing}`
      }
    }
  }
  try {
    // Why dlopen first: node-pty's loader rethrows only its last attempt, which hides the
    // dynamic loader's message the client classifies (GLIBC_x not found, missing .so).
    process.dlopen({ exports: {} }, binding)
  } catch (error) {
    return { ...base, ok: false, stage: 'load', error: errorText(error) }
  }
  let pty: typeof NodePty
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty's own entry, the module the relay's PtyHandler requires by the same path.
    pty = require(join(nodePtyDir, 'lib', 'index.js')) as typeof NodePty
  } catch (error) {
    return { ...base, ok: false, stage: 'load', error: errorText(error) }
  }
  try {
    await openAndClosePty(pty, platform)
  } catch (error) {
    return { ...base, ok: false, stage: 'spawn', error: errorText(error) }
  }
  return { ...base, ok: true }
}

export async function runRelayRuntimeSelfTestCommand(nonce: string): Promise<never> {
  const report = await runRelayRuntimeSelfTest(nonce)
  process.stdout.write(`${RELAY_RUNTIME_SELF_TEST_PREFIX}${JSON.stringify(report)}\n`, () =>
    process.exit(0)
  )
  return new Promise<never>(() => {})
}
