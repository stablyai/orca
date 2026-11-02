/** Starts one hostile-host cell as an SSH target for the orcad deploy: a Docker sshd or a loopback one. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  FORBIDDEN_TOOL_LOG,
  FORBIDDEN_TOOLS,
  forbiddenToolShimScript,
  forbiddenToolsFor,
  isLocalSshdCell,
  type DockerHostileHostCell,
  type HostileHostCell
} from './ssh-hostile-host-cells'
import {
  parseSshSidePathProbe,
  sshSidePathLeaks,
  sshSidePathProbeCommand,
  startLocalSshdTarget,
  stopLocalSshdTarget,
  type LocalSshdHostileHostTarget
} from './ssh-hostile-host-local-sshd'

export type DockerHostileHostTarget = {
  kind: 'docker'
  cell: DockerHostileHostCell
  username: 'root'
  forbiddenToolLog: string
  containerName: string
  networkName: string | null
  host: string
  port: number
  identityFile: string
  tempDir: string
}

export type HostileHostTarget = DockerHostileHostTarget | LocalSshdHostileHostTarget

async function run(program: string, args: readonly string[], timeoutMs = 60_000): Promise<string> {
  const result = await runProcess({ program, args, timeoutMs })
  if (result.code !== 0) {
    throw new Error(
      `${program} ${args.slice(0, 3).join(' ')} failed (${result.code ?? result.signal}): ${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

// A noexec tmpfs home starts empty; stage keys/modes in the entrypoint.
const ENTRYPOINT = [
  '#!/bin/sh',
  'set -eu',
  'mkdir -p /root/.ssh /run/sshd',
  'chmod 700 /root /root/.ssh',
  `printf '%s\\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys`,
  'chmod 600 /root/.ssh/authorized_keys',
  'ssh-keygen -A >/dev/null',
  'exec /usr/sbin/sshd -D -e',
  ''
].join('\n')

export function hostileHostDockerfile(cell: DockerHostileHostCell): string {
  const shims = FORBIDDEN_TOOLS.map((tool) => `ln -sf orca-forbidden-tool /usr/local/bin/${tool}`)
  return [
    ...cell.dockerfile,
    'COPY forbidden-tool.sh /usr/local/bin/orca-forbidden-tool',
    'COPY entrypoint.sh /orca-entrypoint.sh',
    [
      'RUN chmod 755 /usr/local/bin/orca-forbidden-tool /orca-entrypoint.sh',
      ...shims,
      // Why '*': sshd without PAM refuses key logins to a locked ('!') root account.
      "sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow",
      // Why: pam_loginuid cannot write loginuid in an unprivileged container.
      "{ [ ! -f /etc/pam.d/sshd ] || sed -i 's/^session\\s*required\\s*pam_loginuid.so/session optional pam_loginuid.so/' /etc/pam.d/sshd; }"
    ].join(' && '),
    'CMD ["/orca-entrypoint.sh"]',
    ''
  ].join('\n')
}

async function buildImage(cell: DockerHostileHostCell, contextDir: string): Promise<string> {
  await writeFile(join(contextDir, 'Dockerfile'), hostileHostDockerfile(cell))
  await writeFile(
    join(contextDir, 'forbidden-tool.sh'),
    forbiddenToolShimScript(FORBIDDEN_TOOL_LOG)
  )
  await writeFile(join(contextDir, 'entrypoint.sh'), ENTRYPOINT)
  const image = `orca-ssh-hostile-host:${cell.id}`
  await run('docker', ['build', '-q', '-t', image, contextDir], 900_000)
  return image
}

export async function startHostileHostTarget(cell: HostileHostCell): Promise<HostileHostTarget> {
  if (isLocalSshdCell(cell)) {
    const started = await startLocalSshdTarget(cell)
    try {
      await waitForSshd(started)
      await assertSshSidePathHidesToolchain(started)
      return started
    } catch (error) {
      await stopLocalSshdTarget(started)
      throw error
    }
  }
  return startDockerTarget(cell)
}

async function startDockerTarget(cell: DockerHostileHostCell): Promise<DockerHostileHostTarget> {
  const tempDir = await mkdtemp(join(tmpdir(), `orca-hostile-${cell.id}-`))
  const identityFile = join(tempDir, 'id_ed25519')
  const containerName = `orca-hostile-${cell.id}-${randomUUID().slice(0, 8)}`
  let networkName: string | null = null
  try {
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', identityFile])
    const publicKey = (await readFile(`${identityFile}.pub`, 'utf8')).trim()
    const contextDir = join(tempDir, 'image')
    await mkdir(contextDir)
    const image = await buildImage(cell, contextDir)
    const args = ['run', '-d', '--name', containerName, '-e', `AUTHORIZED_KEY=${publicKey}`]
    if (cell.homeNoexec) {
      args.push('--tmpfs', '/root:rw,noexec,nosuid,mode=700')
    }
    if (cell.noEgress) {
      networkName = `${containerName}-internal`
      await run('docker', ['network', 'create', '--internal', networkName])
      args.push('--network', networkName)
    } else {
      args.push('-p', '127.0.0.1::22')
    }
    await run('docker', [...args, image])
    const target = cell.noEgress
      ? {
          // No-egress containers expose no ports; Linux reaches their internal bridge directly.
          host: await run('docker', [
            'inspect',
            '-f',
            '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
            containerName
          ]),
          port: 22
        }
      : {
          host: '127.0.0.1',
          port: Number((await run('docker', ['port', containerName, '22/tcp'])).split(':').at(-1))
        }
    const started: DockerHostileHostTarget = {
      kind: 'docker',
      cell,
      username: 'root',
      forbiddenToolLog: FORBIDDEN_TOOL_LOG,
      containerName,
      networkName,
      identityFile,
      tempDir,
      ...target
    }
    await waitForSshd(started)
    return started
  } catch (error) {
    await removeContainer(containerName, networkName)
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

function sshArgs(target: HostileHostTarget, command: string): string[] {
  return [
    '-i',
    target.identityFile,
    '-p',
    String(target.port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ConnectTimeout=5',
    `${target.username}@${target.host}`,
    command
  ]
}

async function waitForSshd(target: HostileHostTarget): Promise<void> {
  const deadline = Date.now() + 60_000
  let last = ''
  while (Date.now() < deadline) {
    const result = await runProcess({
      program: 'ssh',
      args: sshArgs(target, 'true'),
      timeoutMs: 15_000
    })
    if (result.code === 0) {
      return
    }
    last = result.stderr || result.stdout
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  const logs =
    target.kind === 'docker'
      ? (await runProcess({ program: 'docker', args: ['logs', target.containerName] })).stderr
      : target.sshdLog()
  throw new Error(`sshd in ${target.cell.id} never accepted the key: ${last}\n${logs}`)
}

/** The deploy's exec channels must find only the shims, and no host Node at all. */
async function assertSshSidePathHidesToolchain(target: LocalSshdHostileHostTarget): Promise<void> {
  const tools = [...forbiddenToolsFor(target.cell), 'node']
  const result = await runProcess({
    program: 'ssh',
    args: sshArgs(target, sshSidePathProbeCommand(tools)),
    timeoutMs: 30_000
  })
  const leaks = sshSidePathLeaks(parseSshSidePathProbe(result.stdout), join(target.tempDir, 'bin'))
  if (result.code !== 0 || leaks.length > 0) {
    throw new Error(`${target.cell.id} SSH PATH leaks: ${leaks.join('; ') || result.stderr}`)
  }
}

async function removeContainer(containerName: string, networkName: string | null): Promise<void> {
  await runProcess({ program: 'docker', args: ['rm', '-f', containerName], timeoutMs: 60_000 })
  if (networkName) {
    await runProcess({ program: 'docker', args: ['network', 'rm', networkName], timeoutMs: 30_000 })
  }
}

export async function stopHostileHostTarget(target: HostileHostTarget | null): Promise<void> {
  if (!target) {
    return
  }
  if (target.kind === 'local-sshd') {
    await stopLocalSshdTarget(target)
    return
  }
  await removeContainer(target.containerName, target.networkName)
  await rm(target.tempDir, { recursive: true, force: true })
}

function observerCommand(target: HostileHostTarget, command: string): string[] {
  return target.kind === 'docker'
    ? ['docker', 'exec', target.containerName, 'sh', '-c', command]
    : ['/bin/sh', '-c', command]
}

export function hostExec(target: HostileHostTarget, command: string): Promise<string> {
  const [program, ...args] = observerCommand(target, command)
  return run(program, args, 120_000)
}

export async function hostExecStatus(target: HostileHostTarget, command: string): Promise<number> {
  const [program, ...args] = observerCommand(target, command)
  const result = await runProcess({ program, args, timeoutMs: 60_000 })
  return result.code ?? -1
}

export function hostileHostSshTarget(target: HostileHostTarget): SshTarget {
  return {
    id: `hostile-${target.cell.id}-${randomUUID()}`,
    label: `Hostile host ${target.cell.id}`,
    source: 'manual',
    host: target.host,
    port: target.port,
    username: target.username,
    identityFile: target.identityFile,
    identitiesOnly: true
  }
}
