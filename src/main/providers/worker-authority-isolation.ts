import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST,
  type WorkerAuthorityIsolationLaunchRequest
} from '../../shared/worker-authority-policy'
import {
  WORKER_AUTHORITY_CID_FILE,
  WORKER_AUTHORITY_DOCKER_PATH,
  WORKER_AUTHORITY_NONCE_LABEL,
  WORKER_AUTHORITY_POLICY_LABEL,
  WORKER_AUTHORITY_ROOT_LABEL,
  WORKER_AUTHORITY_ROOT_PREFIX,
  type WorkerAuthorityDaemonOwner
} from './worker-authority-container-contract'
import {
  assertWorkerAuthorityDaemonOwner,
  createWorkerAuthorityOwnerRecords
} from './worker-authority-daemon-owner'
import {
  buildWorkerAuthorityContainerEnvironment,
  buildWorkerAuthorityHostEnvironment,
  workerAuthorityMount
} from './worker-authority-container-launch'
import {
  assertNoCredentialBearingGitRemote,
  resolveWorkerAuthorityGitConfigPaths,
  resolveWorkerAuthorityGitMetadataPaths
} from './worker-authority-git-boundary'

export { WORKER_AUTHORITY_DOCKER_PATH } from './worker-authority-container-contract'
export const WORKER_AUTHORITY_IMAGE =
  'orca-worker-authority@sha256:61c753139eaa20729b3bc7ec1d39a8192c4768865599f6171facccce357c6fe8'

const MAX_PROVIDER_CREDENTIAL_BYTES = 1024 * 1024
const DEDICATED_CODEX_HOME_ENV = 'ORCA_WORKER_CODEX_HOME'

export type PreparedWorkerAuthorityIsolation = {
  executable: string
  arguments: string[]
  hostEnv: Record<string, string>
  isolatedHomePath: string
  cleanup: (forceContainerRemoval?: boolean) => Promise<void>
}

async function cleanupOwnedContainer(cidfilePath: string): Promise<boolean> {
  try {
    const cid = readFileSync(cidfilePath, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(cid)) {
      return false
    }
    const removal = await runProcess({
      program: WORKER_AUTHORITY_DOCKER_PATH,
      args: ['rm', '--force', cid],
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    })
    return removal.code === 0
  } catch {
    return false
  }
}

function assertSupportedRequest(
  request: WorkerAuthorityIsolationLaunchRequest,
  agent: TuiAgent | undefined,
  platform: NodeJS.Platform
): asserts agent is 'codex' {
  if (
    platform !== 'darwin' ||
    agent !== 'codex' ||
    request.schemaVersion !== 'worker_authority_launch/1' ||
    request.policy !== NO_GITHUB_AUTHORITY_POLICY ||
    request.policyDigest !== NO_GITHUB_AUTHORITY_POLICY_DIGEST ||
    request.imageDigest !== WORKER_AUTHORITY_IMAGE
  ) {
    throw new Error('worker_authority_policy_unsupported')
  }
}

function readProviderCredential(sourcePath: string): Buffer {
  const stat = lstatSync(sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROVIDER_CREDENTIAL_BYTES) {
    throw new Error('worker_authority_isolation_failed')
  }
  const credential = readFileSync(sourcePath)
  let value: unknown
  try {
    value = JSON.parse(credential.toString('utf8')) as unknown
  } catch {
    throw new Error('worker_authority_isolation_failed')
  }
  if (!hasCodexAuthenticationMaterial(value)) {
    throw new Error('worker_authority_isolation_failed')
  }
  return credential
}

function hasCodexAuthenticationMaterial(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const auth = value as Record<string, unknown>
  const tokens =
    auth.tokens && typeof auth.tokens === 'object' && !Array.isArray(auth.tokens)
      ? (auth.tokens as Record<string, unknown>)
      : undefined
  const nonEmpty = (candidate: unknown): boolean =>
    typeof candidate === 'string' && candidate.trim().length > 0
  return (
    nonEmpty(auth.OPENAI_API_KEY) ||
    nonEmpty(auth.personal_access_token) ||
    nonEmpty(auth.agent_identity) ||
    nonEmpty(tokens?.access_token)
  )
}

function resolveCodexCredentialPath(env: Record<string, string>, hostHome: string): string {
  const configuredHome = env[DEDICATED_CODEX_HOME_ENV]?.trim()
  if (!configuredHome) {
    throw new Error('worker_authority_isolation_failed')
  }
  const sourceHome = resolve(hostHome, configuredHome)
  const resolvedHome = realpathSync(sourceHome)
  const ordinaryCodexHomes = [resolve(hostHome, '.codex')]
  const configuredOrdinaryHome = env.CODEX_HOME?.trim()
  if (configuredOrdinaryHome) {
    ordinaryCodexHomes.push(resolve(hostHome, configuredOrdinaryHome))
  }
  if (
    ordinaryCodexHomes.some((path) => {
      try {
        return realpathSync(path) === resolvedHome
      } catch {
        return path === resolvedHome
      }
    })
  ) {
    throw new Error('worker_authority_isolation_failed')
  }
  const requestedCredentialPath = join(resolvedHome, 'auth.json')
  const credentialPath = realpathSync(requestedCredentialPath)
  if (credentialPath !== requestedCredentialPath || dirname(credentialPath) !== resolvedHome) {
    throw new Error('worker_authority_isolation_failed')
  }
  return credentialPath
}

export async function verifyWorkerAuthorityContainerRuntime(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    readProviderCredential(
      resolveCodexCredentialPath(process.env as Record<string, string>, homedir())
    )
    const result = await runProcess({
      program: WORKER_AUTHORITY_DOCKER_PATH,
      args: ['image', 'inspect', WORKER_AUTHORITY_IMAGE, '--format', '{{.Id}}'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    })
    return (
      result.code === 0 &&
      result.stdout.trim() === WORKER_AUTHORITY_IMAGE.slice('orca-worker-authority@'.length)
    )
  } catch {
    return false
  }
}

export function prepareWorkerAuthorityIsolation(args: {
  request: WorkerAuthorityIsolationLaunchRequest
  agent: TuiAgent | undefined
  env: Record<string, string>
  workspacePath: string
  command: string | undefined
  /** Process-owner configuration only; never pass terminal or repository launch environment. */
  authorityCredentialEnv?: Record<string, string>
  owner: WorkerAuthorityDaemonOwner
  platform?: NodeJS.Platform
  hostHome?: string
  tempRoot?: string
}): PreparedWorkerAuthorityIsolation {
  const platform = args.platform ?? process.platform
  assertSupportedRequest(args.request, args.agent, platform)
  assertWorkerAuthorityDaemonOwner(args.owner)
  if (
    !args.command ||
    Buffer.byteLength(args.command) > 64 * 1024 ||
    getFirstCommandToken(args.command) !== 'codex'
  ) {
    throw new Error('worker_authority_isolation_failed')
  }
  const hostHome = resolve(args.hostHome ?? homedir())
  const tempRoot = resolve(args.tempRoot ?? tmpdir())
  const workspacePath = realpathSync(args.workspacePath)
  const lifecycleDirectory = realpathSync(args.request.lifecycleDirectory)
  const lifecycleStat = lstatSync(lifecycleDirectory)
  if (!lifecycleStat.isDirectory() || lifecycleStat.isSymbolicLink()) {
    throw new Error('worker_authority_isolation_failed')
  }
  const isolationRoot = mkdtempSync(join(tempRoot, WORKER_AUTHORITY_ROOT_PREFIX))
  const isolatedHomePath = join(isolationRoot, 'home')
  const cidfilePath = join(isolationRoot, WORKER_AUTHORITY_CID_FILE)
  let cleanupPromise: Promise<void> | undefined
  try {
    const gitMetadataPaths = resolveWorkerAuthorityGitMetadataPaths(workspacePath)
    const gitConfigPaths = resolveWorkerAuthorityGitConfigPaths(gitMetadataPaths)
    assertNoCredentialBearingGitRemote(gitMetadataPaths)
    mkdirSync(isolatedHomePath, { mode: 0o700 })
    const ownershipNonce = createWorkerAuthorityOwnerRecords({ isolationRoot, owner: args.owner })
    const sanitizedGitConfigPath = join(isolationRoot, 'git-config')
    writeFileSync(sanitizedGitConfigPath, '', { mode: 0o600, flag: 'wx' })
    for (const path of ['.codex', '.config/gh', '.cache']) {
      mkdirSync(join(isolatedHomePath, path), { recursive: true, mode: 0o700 })
    }
    writeFileSync(
      join(isolatedHomePath, '.codex', 'config.toml'),
      `[projects.${JSON.stringify(workspacePath)}]\ntrust_level = "trusted"\n`,
      { mode: 0o600, flag: 'wx' }
    )
    const credential = readProviderCredential(
      resolveCodexCredentialPath(
        args.authorityCredentialEnv ?? (process.env as Record<string, string>),
        hostHome
      )
    )
    writeFileSync(join(isolatedHomePath, '.codex', 'auth.json'), credential, {
      mode: 0o600,
      flag: 'wx'
    })
    const uid = process.getuid?.() ?? 10001
    const gid = process.getgid?.() ?? 10001
    const arguments_ = [
      'run',
      '--rm',
      '--interactive',
      '--tty',
      '--cidfile',
      cidfilePath,
      '--label',
      `${WORKER_AUTHORITY_POLICY_LABEL}=${NO_GITHUB_AUTHORITY_POLICY_DIGEST}`,
      '--label',
      `${WORKER_AUTHORITY_ROOT_LABEL}=${isolationRoot}`,
      '--label',
      `${WORKER_AUTHORITY_NONCE_LABEL}=${ownershipNonce}`,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=256',
      '--memory=4g',
      '--cpus=2',
      '--user',
      `${uid}:${gid}`,
      '--workdir',
      workspacePath,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=268435456,mode=1777',
      '--mount',
      workerAuthorityMount(workspacePath, workspacePath, 'rw'),
      ...gitMetadataPaths.flatMap((path) => ['--mount', workerAuthorityMount(path, path, 'ro')]),
      ...gitConfigPaths.flatMap((path) => [
        '--mount',
        workerAuthorityMount(sanitizedGitConfigPath, path, 'ro')
      ]),
      '--mount',
      workerAuthorityMount(isolatedHomePath, '/home/orca-worker', 'rw'),
      '--mount',
      workerAuthorityMount(lifecycleDirectory, '/orca-control', 'rw'),
      ...buildWorkerAuthorityContainerEnvironment(args.request),
      WORKER_AUTHORITY_IMAGE,
      '/bin/bash',
      '-lc',
      args.command
    ]
    return {
      executable: WORKER_AUTHORITY_DOCKER_PATH,
      arguments: arguments_,
      hostEnv: buildWorkerAuthorityHostEnvironment(args.env),
      isolatedHomePath,
      cleanup: (forceContainerRemoval = true) => {
        cleanupPromise ??= (async () => {
          const mayRemoveOwnershipRecord = forceContainerRemoval
            ? await cleanupOwnedContainer(cidfilePath)
            : true
          if (mayRemoveOwnershipRecord) {
            rmSync(isolationRoot, { recursive: true, force: true })
          }
        })()
        return cleanupPromise
      }
    }
  } catch (error) {
    rmSync(isolationRoot, { recursive: true, force: true })
    throw error
  }
}
