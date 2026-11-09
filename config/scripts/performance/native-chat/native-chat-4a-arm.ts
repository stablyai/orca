// One 4a arm: a built checkout, its own envelope/fingerprint builders, and background launches it alone stops by recorded PID.
// Declares the window.__store and window.api globals these page.evaluate callbacks use.
import type {} from '../../../../tests/e2e/helpers/runtime-types'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, constants, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import {
  createElectronHomeIsolation,
  assertElectronResolvedIsolatedHome
} from '../../../../tests/e2e/helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from '../../../../tests/e2e/helpers/electron-launch-args'
import { closeElectronAppForE2E } from '../../../../tests/e2e/helpers/electron-process-shutdown'
import { getE2ECompletedOnboardingProfile } from '../../../../tests/e2e/helpers/e2e-completed-onboarding-profile'
import { buildFakeAgentCommandOverride } from '../../../../tests/e2e/helpers/fake-agent-command-override'
import { installVisibilityProbe } from './native-chat-4a-probes'

const HARNESS_ROOT = path.resolve(import.meta.dirname, '../../../..')
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** Envelope builders compiled from the arm's own source, so each host checks fingerprints it computes itself. */
export type ArmProtocol = {
  structuredAgentSessionPayloadFingerprint: (input: {
    method: string
    sessionId: string
    fields: Record<string, unknown>
  }) => string
  structuredAgentSessionCreateFingerprint: (input: {
    sessionId: string
    worktree: string
    agent: string
    forkFrom?: unknown
  }) => string
  createStructuredAgentSessionOperationId: (randomUuid: () => string) => string
  createStructuredAgentSessionId: (agent: string, randomUuid: () => string) => string
  structuredAgentSessionMessageSendMutation: (message: {
    sessionId: string
    clientOperationId: string
    expectedRuntimeFence: number
    body: { kind: 'message'; role: 'user'; blocks: { type: 'text'; text: string }[] }
    delivery?: 'queue-if-active'
  }) => { envelope: unknown; body: unknown; delivery?: 'queue-if-active' }
  agentSessionSendBodyFingerprint: (sessionId: string, body: unknown) => string
}

export type Arm = {
  name: string
  root: string
  sha: string
  electronPath: string
  protocol: ArmProtocol
}

export type Launch = {
  app: ElectronApplication
  page: Page
  pid: number
  /** `ps` start time recorded at launch; stop refuses a PID whose start time changed. */
  startedAt: string
  userDataDir: string
  launchedAtEpochMs: number
  /** When the renderer reported its workspace session ready: launch-to-ready is metadata initialization. */
  readyEpochMs: number
}

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

export async function resolveArm(name: string, root: string, scratch: string): Promise<Arm> {
  const absolute = path.resolve(root)
  if (!existsSync(path.join(absolute, 'out', 'main', 'index.js'))) {
    throw new Error(`${name}: ${absolute} has no out/main/index.js; build that checkout first`)
  }
  const electronPath = createRequire(path.join(absolute, 'package.json'))('electron') as string
  const outfile = path.join(scratch, `${name}-protocol.cjs`)
  const shared = './src/shared/agent-session'
  await build({
    stdin: {
      contents: [
        `export * from '${shared}/lifecycle/structured-agent-session-mutation'`,
        `export { createStructuredAgentSessionId } from '${shared}/structured-agent-session-create'`,
        `export { structuredAgentSessionMessageSendMutation, agentSessionSendBodyFingerprint } from '${shared}/requests/structured-agent-session-send-mutation'`
      ].join(';'),
      resolveDir: absolute
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
    nodePaths: [path.join(HARNESS_ROOT, 'node_modules')]
  })
  const protocol = createRequire(import.meta.url)(outfile) as ArmProtocol
  return { name, root: absolute, sha: git(absolute, 'rev-parse', 'HEAD'), electronPath, protocol }
}

/** The stub wrapper and its directory; the launch PATH holds only it and the system tool dirs. */
export function writeProviderStub(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const command = path.join(dir, 'claude')
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  const stub = path.join(import.meta.dirname, 'native-chat-4a-provider-stub.cjs')
  writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stub)} ${quote(path.join(dir, 'launches.jsonl'))} "$@"\n`
  )
  chmodSync(command, 0o755)
  return command
}

function processStart(pid: number): string {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
}

export async function launchArm(
  arm: Arm,
  userDataDir: string,
  stubCommand: string
): Promise<Launch> {
  mkdirSync(userDataDir, { recursive: true })
  const profile = path.join(userDataDir, 'orca-data.json')
  if (!existsSync(profile)) {
    writeFileSync(profile, `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`)
  }
  const { ELECTRON_RUN_AS_NODE: _unused, ...inherited } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: inherited,
    launchEnv: { PATH: [path.dirname(stubCommand), ...SYSTEM_DIRS].join(path.delimiter) },
    extraEnv: {},
    userDataDir
  })
  const launchedAtEpochMs = Date.now()
  const app = await electron.launch({
    executablePath: arm.electronPath,
    args: getOrcaElectronLaunchArgs(path.join(arm.root, 'out', 'main', 'index.js'), false),
    env: {
      ...isolation.env,
      NODE_ENV: 'development',
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_EVENT_LOOP_DELAY_PROBE: '1'
    }
  })
  const pid = app.process().pid
  if (!pid) {
    await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: userDataDir })
    throw new Error(`${arm.name}: launch recorded no PID`)
  }
  const startedAt = processStart(pid)
  try {
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      isolation
    )
    const page = await app.firstWindow({ timeout: 120_000 })
    // tsx keeps function names by wrapping them in __name(), which page.evaluate callbacks carry into the renderer.
    const nameShim = 'globalThis.__name ??= (fn) => fn'
    await page.addInitScript(nameShim)
    await page.evaluate(nameShim)
    // Only an e2e-mode build exposes the store; a desktop build would otherwise wait out the full budget.
    await page
      .waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
      .catch(() => {
        throw new Error(
          `${arm.name}: no window.__store; build ${arm.root} with VITE_EXPOSE_STORE=true electron-vite build --mode e2e`
        )
      })
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 600_000, polling: 16 }
    )
    await installVisibilityProbe(page)
    return { app, page, pid, startedAt, userDataDir, launchedAtEpochMs, readyEpochMs: Date.now() }
  } catch (error) {
    await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: userDataDir })
    throw error
  }
}

export async function stopArm(launch: Launch): Promise<void> {
  const current = (() => {
    try {
      return processStart(launch.pid)
    } catch {
      return null
    }
  })()
  if (current !== null && current !== launch.startedAt) {
    throw new Error(
      `PID ${launch.pid} is no longer the process this harness launched; not stopping it`
    )
  }
  await closeElectronAppForE2E(launch.app, { cleanupDaemonsForUserDataDir: launch.userDataDir })
}

export type Workspace = { repoId: string; worktreeIds: [string, string] }

/** Attach the seeded repo, trust it and route Claude to the stub, the way the e2e fixture prepares a profile. */
export async function prepareWorkspace(
  page: Page,
  repoPath: string,
  stubCommand: string
): Promise<Workspace> {
  const override = buildFakeAgentCommandOverride(stubCommand)
  return page.evaluate(
    async ({ repoPath, override }) => {
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      const store = window.__store!
      await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      await store.getState().updateRepo(added.repo.id, {
        externalWorktreeVisibility: 'show',
        agentWorkspaceTrust: 'pre-trust'
      })
      await store.getState().updateSettings({
        nativeChatProviders: { claude: true, codex: true },
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: override }
      })
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await store.getState().fetchWorktrees(added.repo.id)
        const worktrees = store.getState().worktreesByRepo[added.repo.id] ?? []
        if (worktrees.length >= 2) {
          const ordered = [...worktrees].sort(
            (a, b) => Number(b.isMainWorktree) - Number(a.isMainWorktree)
          )
          store.getState().setActiveWorktree(ordered[0]!.id)
          return {
            repoId: added.repo.id,
            worktreeIds: [ordered[0]!.id, ordered[1]!.id] as [string, string]
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error('seeded worktrees did not load')
    },
    { repoPath, override }
  )
}

/** Profiles hold absolute home paths (provider transcripts, config pins), so every arm runs at the same `to` path. */
export function copyProfile(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE
  })
}

export const operationId = (arm: Arm): string =>
  arm.protocol.createStructuredAgentSessionOperationId(randomUUID)
