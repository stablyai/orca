import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { exportLocalNodeHeadersPrefix, localNodeHeadersFromOutput } from './ssh-relay-node-headers'

const POSIX = process.platform !== 'win32'

/** Runs the prefix under /bin/sh exactly as the relay does, then prints what node-gyp would see. */
function runPrefix(nodePath: string): {
  nodedir: string
  pkgNodedir: string
  marker: string | null | undefined
} {
  const script = `${exportLocalNodeHeadersPrefix(nodePath)}printf '%s\\n%s\\n' "$npm_config_nodedir" "$npm_package_config_node_gyp_nodedir"`
  const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const marker = localNodeHeadersFromOutput(result.stdout)
  const [nodedir = '', pkgNodedir = ''] = result.stdout
    .split('\n')
    .filter((line) => !line.startsWith('ORCA-NODE-HEADERS:'))
  return { nodedir, pkgNodedir, marker }
}

/** A fake `<prefix>/bin/node` whose `include/node/node_version.h` claims `version`. */
function fakeNodePrefix(root: string, version: string): string {
  const prefix = join(root, 'prefix')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'include', 'node'), { recursive: true })
  const [major, minor, patch] = version.split('.')
  writeFileSync(
    join(prefix, 'include', 'node', 'node_version.h'),
    `#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n#define NODE_PATCH_VERSION ${patch}\n`
  )
  // Why a symlink to the real binary: the probe reads process.execPath, which Node resolves
  // through symlinks -- so this stands in for `/usr/bin/node -> /opt/node/bin/node` shims too.
  symlinkSync(process.execPath, join(prefix, 'bin', 'node'))
  return join(prefix, 'bin', 'node')
}

describe.skipIf(!POSIX)('exportLocalNodeHeadersPrefix', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exports nodedir when the running Node ships headers for its own version', () => {
    // The test runner's Node is an official build, so its prefix has include/node.
    const prefix = dirname(dirname(process.execPath))
    const { nodedir, pkgNodedir, marker } = runPrefix(process.execPath)
    expect(nodedir).toBe(prefix)
    expect(pkgNodedir).toBe(prefix)
    expect(marker).toBe(prefix)
  })

  it('leaves nodedir unset when the shipped headers are for another Node version', () => {
    // A symlinked node resolves execPath to the real binary, whose prefix is the real one; so
    // to stage a mismatch the probe must run a node whose execPath lands in the fake prefix.
    // A copy does that.
    const root = mkdtempSync(join(tmpdir(), 'orca-node-headers-'))
    roots.push(root)
    const prefix = join(root, 'prefix')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    mkdirSync(join(prefix, 'include', 'node'), { recursive: true })
    writeFileSync(
      join(prefix, 'include', 'node', 'node_version.h'),
      '#define NODE_MAJOR_VERSION 1\n#define NODE_MINOR_VERSION 0\n#define NODE_PATCH_VERSION 0\n'
    )
    const copied = join(prefix, 'bin', 'node')
    copyFileSync(process.execPath, copied)
    chmodSync(copied, 0o755)
    const { nodedir, pkgNodedir, marker } = runPrefix(copied)
    expect(nodedir).toBe('')
    expect(pkgNodedir).toBe('')
    expect(marker).toBeNull()
  })

  it('leaves nodedir unset when the prefix has no headers at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-node-headers-'))
    roots.push(root)
    const copied = join(root, 'bin', 'node')
    mkdirSync(dirname(copied), { recursive: true })
    copyFileSync(process.execPath, copied)
    chmodSync(copied, 0o755)
    const { nodedir } = runPrefix(copied)
    expect(nodedir).toBe('')
  })

  it('follows a symlinked node to the install that owns the headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-node-headers-'))
    roots.push(root)
    const shim = fakeNodePrefix(root, '0.0.0')
    // The shim's own fake headers are ignored: execPath resolves to the real binary, and the
    // real prefix's headers are the ones that match.
    const { nodedir } = runPrefix(shim)
    expect(nodedir).toBe(dirname(dirname(process.execPath)))
  })

  it('clears an inherited nodedir when the probe finds no matching headers', () => {
    // A remote profile's stale nodedir must not survive past the version check.
    const root = mkdtempSync(join(tmpdir(), 'orca-node-headers-'))
    roots.push(root)
    const copied = join(root, 'bin', 'node')
    mkdirSync(dirname(copied), { recursive: true })
    copyFileSync(process.execPath, copied)
    chmodSync(copied, 0o755)
    const script = `${exportLocalNodeHeadersPrefix(copied)}printf '%s|%s|%s' "$npm_config_nodedir" "$NPM_CONFIG_NODEDIR" "$npm_package_config_node_gyp_nodedir"`
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_nodedir: '/usr/stale-headers',
        NPM_CONFIG_NODEDIR: '/usr/stale-headers',
        npm_package_config_node_gyp_nodedir: '/usr/stale-headers'
      }
    })
    expect(result.status).toBe(0)
    expect(result.stdout.split('\n').at(-1)).toBe('||')
  })

  it('does not fail the command line when node itself cannot run', () => {
    const script = `${exportLocalNodeHeadersPrefix('/nonexistent/node')}echo "after:$npm_config_nodedir"`
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('ORCA-NODE-HEADERS:none\nafter:')
  })
})

describe('localNodeHeadersFromOutput', () => {
  it('reads the host answer, not the copy of the marker echo quoted in an exec-failure head', () => {
    // The real shape: execCommand quotes the whole command line, prefix included, before the output.
    const command = `export PATH='/usr/local/bin':$PATH && cd '/root/.orca-remote/relay-x' && ${exportLocalNodeHeadersPrefix('/usr/local/bin/node')}npm install node-pty 2>&1`
    const failed = (hostOutput: string): string =>
      `Command "${command}" failed (exit 1): ${hostOutput}`
    expect(
      localNodeHeadersFromOutput(failed('ORCA-NODE-HEADERS:none\ngyp ERR! configure error'))
    ).toBeNull()
    expect(
      localNodeHeadersFromOutput(failed('ORCA-NODE-HEADERS:/usr/local\ngyp ERR! configure error'))
    ).toBe('/usr/local')
    // No host output at all after the head: the command copy alone must not count as a marker.
    expect(localNodeHeadersFromOutput(failed(''))).toBeUndefined()
  })

  it('distinguishes an exported dir, an explicit none, and no marker at all', () => {
    expect(localNodeHeadersFromOutput('x\nORCA-NODE-HEADERS:/usr/local\ngyp ERR!')).toBe(
      '/usr/local'
    )
    expect(localNodeHeadersFromOutput('ORCA-NODE-HEADERS:none\ngyp ERR!')).toBeNull()
    expect(localNodeHeadersFromOutput('gyp ERR! only')).toBeUndefined()
  })
})
