/**
 * Runs a local-sshd hostile-host cell: a user-level sshd on a loopback port that logs in as the
 * runner user, so a macOS runner can be the SSH host without system changes or a second account.
 *
 * What the SSH side cannot hide on macOS: /usr/bin/{cc,gcc,g++,c++,make,xattr,python3} are
 * SIP-protected xcrun stubs, so the shims only shadow them by PATH order, and an absolute
 * `/usr/bin/cc` call would bypass the log. A PTY's login shell re-runs path_helper from
 * /etc/paths, which puts Homebrew back for the terminal (not for the deploy's exec channels).
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join, posix } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  forbiddenToolShimScript,
  forbiddenToolsFor,
  type LocalSshdHostileHostCell
} from './ssh-hostile-host-cells'

export type LocalSshdHostileHostTarget = {
  kind: 'local-sshd'
  cell: LocalSshdHostileHostCell
  host: string
  port: number
  username: string
  identityFile: string
  tempDir: string
  /** The HOME the SSH session sees; the runtime store lands under it. */
  home: string
  forbiddenToolLog: string
  sshd: ReturnType<typeof spawnProcess>
  sshdLog: () => string
}

export const LOCAL_SSHD_BASE_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

export type LocalSshdConfigInput = {
  port: number
  hostKey: string
  pidFile: string
  authorizedKeys: string
  shimDir: string
  home: string
}

export function localSshdConfig(input: LocalSshdConfigInput): string {
  const path = [input.shimDir, ...LOCAL_SSHD_BASE_PATH].join(':')
  for (const value of [path, input.home, input.hostKey, input.pidFile, input.authorizedKeys]) {
    // Why: sshd_config splits on whitespace and has no escaping we could rely on across versions.
    if (/[\s"']/.test(value)) {
      throw new Error(`local sshd paths must not contain whitespace or quotes: ${value}`)
    }
  }
  return [
    `Port ${input.port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${input.hostKey}`,
    `PidFile ${input.pidFile}`,
    `AuthorizedKeysFile ${input.authorizedKeys}`,
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    // Why: a non-root sshd cannot use PAM, and the temp tree is not root-owned for StrictModes.
    'UsePAM no',
    'StrictModes no',
    // Why internal: sftp-server lives at a different path on each OS.
    'Subsystem sftp internal-sftp',
    // SetEnv overrides sshd's defaults; an empty HOME means no rc file restores the real PATH.
    `SetEnv PATH=${path} HOME=${input.home}`,
    'LogLevel VERBOSE',
    ''
  ].join('\n')
}

async function run(program: string, args: readonly string[]): Promise<void> {
  const result = await runProcess({ program, args, timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new Error(`${program} failed (${result.code ?? result.signal}): ${result.stderr}`)
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no loopback port'))))
    })
  })
}

export async function startLocalSshdTarget(
  cell: LocalSshdHostileHostCell
): Promise<LocalSshdHostileHostTarget> {
  // Why /tmp: the remote home holds relay sockets, and macOS caps sun_path at 104 bytes.
  const tempDir = await mkdtemp(join(await realpath('/tmp'), 'orca-hh-'))
  try {
    const home = join(tempDir, 'home')
    const shimDir = join(tempDir, 'bin')
    const forbiddenToolLog = join(tempDir, 'forbidden-tool-calls.log')
    const identityFile = join(tempDir, 'id_ed25519')
    const hostKey = join(tempDir, 'ssh_host_ed25519_key')
    const authorizedKeys = join(tempDir, 'authorized_keys')
    await mkdir(home, { mode: 0o700 })
    await mkdir(shimDir)
    await writeFile(
      join(shimDir, 'orca-forbidden-tool'),
      forbiddenToolShimScript(forbiddenToolLog),
      {
        mode: 0o755
      }
    )
    for (const tool of forbiddenToolsFor(cell)) {
      await symlink('orca-forbidden-tool', join(shimDir, tool))
    }
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', identityFile])
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', hostKey])
    await writeFile(authorizedKeys, await readFile(`${identityFile}.pub`, 'utf8'), { mode: 0o600 })
    const port = await freeLoopbackPort()
    const configFile = join(tempDir, 'sshd_config')
    await writeFile(
      configFile,
      localSshdConfig({
        port,
        hostKey,
        pidFile: join(tempDir, 'sshd.pid'),
        authorizedKeys,
        shimDir,
        home
      })
    )
    // Why absolute: sshd refuses to re-exec itself from a relative path.
    const sshd = spawnProcess({ program: '/usr/sbin/sshd', args: ['-D', '-e', '-f', configFile] })
    let log = ''
    sshd.stderr.on('data', (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-16_384)
    })
    sshd.stdout.resume()
    return {
      kind: 'local-sshd',
      cell,
      host: '127.0.0.1',
      port,
      username: userInfo().username,
      identityFile,
      tempDir,
      home,
      forbiddenToolLog,
      sshd,
      sshdLog: () => log
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

async function waitForNoProcessMatching(pattern: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await runProcess({ program: 'pgrep', args: ['-f', pattern], timeoutMs: 10_000 })
    if (result.code === 1) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

export async function stopLocalSshdTarget(target: LocalSshdHostileHostTarget): Promise<void> {
  if (target.sshd.exitCode === null && target.sshd.signalCode === null) {
    const exited = new Promise((resolve) => target.sshd.once('exit', resolve))
    target.sshd.kill('SIGTERM')
    await exited
  }
  // Why: the relay daemonizes out of the sshd session; it runs from the temp home, so its argv names it.
  await runProcess({ program: 'pkill', args: ['-TERM', '-f', target.tempDir], timeoutMs: 10_000 })
  if (!(await waitForNoProcessMatching(target.tempDir, 10_000))) {
    await runProcess({ program: 'pkill', args: ['-KILL', '-f', target.tempDir], timeoutMs: 10_000 })
    await waitForNoProcessMatching(target.tempDir, 5_000)
  }
  await rm(target.tempDir, { recursive: true, force: true })
}

/** How each forbidden tool and `node` resolve on the SSH side; anything but a shim is a leak. */
export function sshSidePathLeaks(
  resolved: Record<string, string | null>,
  shimDir: string
): string[] {
  return Object.entries(resolved).flatMap(([tool, path]) => {
    if (tool === 'node') {
      return path ? [`node resolves to ${path}`] : []
    }
    return path === posix.join(shimDir, tool) ? [] : [`${tool} resolves to ${path ?? 'nothing'}`]
  })
}

/** One `command -v` line per tool, empty when the tool is absent. */
export function sshSidePathProbeCommand(tools: readonly string[]): string {
  return tools.map((tool) => `printf '%s=%s\\n' ${tool} "$(command -v ${tool})"`).join('; ')
}

export function parseSshSidePathProbe(output: string): Record<string, string | null> {
  const resolved: Record<string, string | null> = {}
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      resolved[line.slice(0, separator)] = line.slice(separator + 1).trim() || null
    }
  }
  return resolved
}
