/**
 * The pinned-Node relay install as a host sees it, with this machine as the host: the runtime
 * promoted from the official archive, relay + slot addons in a runtime-folded version dir, the
 * self-test, then a detached daemon on the pinned Node answering a `--connect` handshake.
 *
 * Needs build outputs, so it skips unless all are present: the pinned archive
 * (ORCA_NODE_RUNTIME_CACHE_DIR or out/node-runtime-cache), `pnpm build:relay`, and an orcad
 * build for this host (ORCA_E2E_ORCAD_DIR or out/orcad).
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import {
  promoteRemoteNodeRuntimeCommand,
  remoteNodeRuntimeDir,
  REMOTE_NODE_RUNTIME_READY
} from './orcad-remote-node-runtime'
import {
  pinnedNodeRelayFullVersion,
  pinnedRelayNodePath,
  stagePinnedRelayAddons
} from './ssh-relay-pinned-node'
import {
  evaluatePinnedRuntimeVersion,
  evaluateRelayRuntimeSelfTest,
  pinnedRuntimeVersionCommand,
  relayRuntimeSelfTestCommand
} from './ssh-relay-runtime-self-test'
import { getRemoteHostPlatform } from './ssh-remote-platform'

function hostTarget(): ServerTarget | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  return null
}

const target = hostTarget()
const relayPlatform = `${process.platform}-${process.arch}`
const archive = target
  ? [process.env.ORCA_NODE_RUNTIME_CACHE_DIR, resolve('out/node-runtime-cache')]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, NODE_RUNTIME_ASSETS[target].archive))
      .find((path) => existsSync(path))
  : undefined
const localRelayDir = resolve('out/relay', relayPlatform)
const orcadDir = process.env.ORCA_E2E_ORCAD_DIR ?? resolve('out/orcad')
const ready =
  !!target &&
  !!archive &&
  existsSync(join(localRelayDir, 'relay.js')) &&
  existsSync(join(orcadDir, 'node_modules/node-pty/build/Release/pty.node'))

function sh(
  command: string,
  timeoutMs = 60_000
): { stdout: string; stderr: string; code: number | null } {
  const result = runProcessSync({ program: '/bin/sh', args: ['-c', command], timeoutMs })
  return { stdout: result.stdout, stderr: result.stderr, code: result.code }
}

const directories: string[] = []
afterAll(() => {
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(!ready)('pinned-Node relay on a local POSIX host', () => {
  it('installs, self-tests and serves a handshake from the pinned runtime', async () => {
    const host = getRemoteHostPlatform(
      relayPlatform === 'darwin-arm64' ? 'darwin-arm64' : 'darwin-x64'
    )
    const home = mkdtempSync(join(tmpdir(), 'orca-pin-'))
    directories.push(home)
    const addons = await stagePinnedRelayAddons(orcadDir, target!)
    const baseVersion = sh(`cat ${JSON.stringify(join(localRelayDir, '.version'))}`).stdout.trim()
    const fullVersion = pinnedNodeRelayFullVersion(
      baseVersion,
      NODE_RUNTIME_ASSETS[target!].executableSha256,
      addons.digest
    )
    const relayDir = join(home, '.orca-remote', `relay-${fullVersion}`)
    cpSync(localRelayDir, relayDir, { recursive: true })
    cpSync(addons.dir, relayDir, { recursive: true })
    await addons.dispose()
    writeFileSync(join(relayDir, '.version'), fullVersion)

    const runtimeDir = remoteNodeRuntimeDir(host, relayDir, target!)
    const stageDir = join(home, '.orca-remote', 'runtimes', '.stage-e2e')
    mkdirSync(stageDir, { recursive: true })
    copyFileSync(archive!, join(stageDir, NODE_RUNTIME_ASSETS[target!].archive))
    const promoted = sh(
      promoteRemoteNodeRuntimeCommand(host, {
        stageDir,
        archive: NODE_RUNTIME_ASSETS[target!].archive,
        runtimeDir,
        target: target!,
        token: 'e2e'
      })
    )
    expect(promoted.stdout.trim().split('\n').at(-1)).toBe(REMOTE_NODE_RUNTIME_READY)

    const nodePath = pinnedRelayNodePath(host, relayDir, target!)
    expect(
      evaluatePinnedRuntimeVersion(sh(pinnedRuntimeVersionCommand(nodePath)).stdout)
    ).toBeNull()
    const selfTest = evaluateRelayRuntimeSelfTest(
      sh(relayRuntimeSelfTestCommand(relayDir, nodePath, 'e2e-nonce')).stdout,
      'e2e-nonce'
    )
    expect(selfTest).toMatchObject({
      verdict: 'passed',
      report: { runtime: 'pinned-node', node: `v${NODE_RUNTIME_PIN.version}` }
    })

    // Short socket dir: a temp $HOME can exceed sun_path.
    const sockDir = mkdtempSync('/tmp/orca-pin-sock-')
    directories.push(sockDir)
    const sock = join(sockDir, 'relay.sock')
    const credential = join(relayDir, 'relay.credential')
    const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
    const launched = sh(
      `cd ${q(relayDir)} && nohup ${q(nodePath)} relay.js --detached --grace-time 60 ` +
        `--sock-path ${q(sock)} --credential-file ${q(credential)} > relay.log 2>&1 </dev/null & echo $!`,
      // The detached daemon keeps an inherited pipe open, as over SSH; stop waiting, not the daemon.
      3_000
    )
    expect(launched.stdout.trim()).toMatch(/^\d+$/)
    try {
      const listening = sh(
        `i=0; while [ $i -lt 100 ]; do [ -S ${q(sock)} ] && [ -f ${q(credential)} ] && echo READY && exit 0; i=$((i+1)); sleep 0.1; done; echo WAITING`,
        20_000
      )
      expect(listening.stdout.trim()).toBe('READY')
      const bridged = sh(
        `cd ${q(relayDir)} && ${q(nodePath)} relay.js --connect --sock-path ${q(sock)} ` +
          `--credential-file ${q(credential)} </dev/null`,
        15_000
      )
      expect(bridged.stdout).toContain('ORCA-RELAY')
      expect(bridged.stderr).toContain(
        `Handshake OK at version=${fullVersion} runtime=pinned-node/${NODE_RUNTIME_PIN.version}`
      )
    } finally {
      // The socket path is unique to this run, so it names only this daemon.
      sh(`pkill -f ${q(sock)} || true`)
    }
  }, 120_000)
})
