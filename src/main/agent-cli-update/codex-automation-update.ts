import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { parseCodexCliVersion } from '../../shared/agent-launch/startup/codex-cli-installation'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { readAgentCliVersion } from '../agent-launch/preflight/agent-cli-version-probe'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  findOwnAgentCli,
  type AgentCliUpdateSettings,
  type OwnAgentCli
} from './agent-cli-own-install'
import { latestAgentCliRelease } from './agent-cli-latest-release'
import { agentCliUpdateDefinition } from './agent-cli-update-agents'
import { updateThroughGate } from './agent-cli-update-gate'
import { runAgentCliUpdatePlan } from './agent-cli-update-service'

const DEADLINE_MS = 10 * 60_000
const codex = agentCliUpdateDefinition('codex')
const NETWORK_ENV =
  /^(?:https?_proxy|all_proxy|no_proxy|curl_ca_bundle|ssl_cert_file|ssl_cert_dir)$/i

export class CodexAutomationUpdateError extends Error {}

type PendingUpdate = {
  controller: AbortController
  signal: AbortSignal
  result: Promise<void>
  waiters: number
}

const pendingUpdates = new Map<string, PendingUpdate>()

/** Only a selected standalone launcher can safely update itself without invoking a package manager. */
async function standaloneUpdateEnvironment(
  cli: OwnAgentCli
): Promise<Record<string, string> | null> {
  const home = cli.env.HOME ?? homedir()
  const codexHome = cli.env.CODEX_HOME || join(home, '.codex')
  const bin = cli.env.CODEX_INSTALL_DIR || join(home, '.local', 'bin')
  if (
    ![home, codexHome, bin].every((path) => isAbsolute(path) && !path.includes(delimiter)) ||
    cli.program !== join(bin, 'codex')
  ) {
    return null
  }
  const root = join(codexHome, 'packages', 'standalone')
  const [releases, selected] = await Promise.all([
    realpath(join(root, 'releases')).catch(() => null),
    realpath(join(root, 'current', 'bin', 'codex')).catch(() =>
      realpath(join(root, 'current', 'codex')).catch(() => null)
    )
  ])
  if (!releases || selected !== cli.realPath || !isPathInsideOrEqual(releases, selected)) {
    return null
  }
  // Keep the selected bin on PATH so the installer leaves shell profiles alone.
  const env = Object.fromEntries(Object.entries(cli.env).filter(([key]) => NETWORK_ENV.test(key)))
  return {
    ...env,
    HOME: home,
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', bin].join(delimiter),
    CODEX_HOME: codexHome,
    CODEX_INSTALL_DIR: bin,
    CODEX_NON_INTERACTIVE: '1'
  }
}

async function readVersion(cli: OwnAgentCli, signal: AbortSignal): Promise<string | null> {
  const { version } = await readAgentCliVersion(
    {
      program: cli.program,
      cwd: homedir(),
      env: cli.version.env,
      prefixArgs: cli.version.prefixArgs,
      operation: { signal },
      quiet: true
    },
    parseCodexCliVersion
  )
  return version
}

async function verifyOrUpdate(
  program: string,
  settings: AgentCliUpdateSettings,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const cli = await findOwnAgentCli('codex', settings)
  if (!cli || cli.program !== program) {
    throw new CodexAutomationUpdateError(
      'The selected Codex installation changed before the run could start.'
    )
  }
  const installed = await readVersion(cli, signal)
  const latest = installed ? await latestAgentCliRelease(codex.latest(installed)) : null
  signal.throwIfAborted()
  if (!installed || !latest) {
    throw new CodexAutomationUpdateError(
      'Orca could not check the installed and latest Codex versions.'
    )
  }
  if (compareAppVersions(installed, latest) >= 0) {
    return
  }
  const plan = codex.plan(installed, cli.realPath)
  const env = plan.runnable ? await standaloneUpdateEnvironment(cli) : null
  signal.throwIfAborted()
  if (!plan.runnable || !env) {
    throw new CodexAutomationUpdateError(
      'This Codex installation requires a manual update before the run can start.'
    )
  }
  const result = await runAgentCliUpdatePlan(
    { ...cli, program: cli.realPath, env },
    plan,
    signal
  ).catch(() => {
    throw new CodexAutomationUpdateError('Orca could not start the Codex updater.')
  })
  agentModelCatalogStore.expireLaunchScopes((agent) => agent === 'codex')
  signal.throwIfAborted()
  if (result.timedOut) {
    throw new CodexAutomationUpdateError('The Codex update timed out.')
  }
  if (result.code !== 0) {
    throw new CodexAutomationUpdateError(
      result.code === null
        ? 'The Codex updater stopped before completing.'
        : `The Codex updater failed (exit code ${result.code}).`
    )
  }
  const updated = await findOwnAgentCli('codex', settings)
  const after =
    updated?.program === program && (await standaloneUpdateEnvironment(updated))
      ? await readVersion(updated, signal)
      : null
  if (!after || compareAppVersions(after, latest) < 0) {
    throw new CodexAutomationUpdateError(
      'Orca could not verify the required Codex version after updating.'
    )
  }
}

/** Calls share the stable launcher, which survives the standalone updater's symlink swap. */
export async function prepareCodexInstallation(
  settings: AgentCliUpdateSettings,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const deadline = AbortSignal.timeout(DEADLINE_MS)
  const waitSignal = AbortSignal.any([signal, deadline])
  try {
    const cli = await waitForPromiseWithSignal(findOwnAgentCli('codex', settings), waitSignal)
    if (!cli) {
      throw new CodexAutomationUpdateError(
        'Orca could not identify a supported Codex installation for this run.'
      )
    }
    const key = await waitForPromiseWithSignal(realpath(dirname(cli.program)), waitSignal)
    const launcher = join(key, 'codex')
    let pending = pendingUpdates.get(launcher)
    if (pending?.signal.aborted) {
      await waitForPromiseWithSignal(
        pending.result.catch(() => undefined),
        waitSignal
      )
      pending = pendingUpdates.get(launcher)
    }
    if (!pending) {
      const controller = new AbortController()
      const updateSignal = AbortSignal.any([controller.signal, deadline])
      const result = updateThroughGate('codex', () =>
        verifyOrUpdate(cli.program, settings, updateSignal)
      ).finally(() => pendingUpdates.delete(launcher))
      pending = { controller, signal: updateSignal, result, waiters: 0 }
      pendingUpdates.set(launcher, pending)
    }
    ++pending.waiters
    try {
      await waitForPromiseWithSignal(pending.result, AbortSignal.any([waitSignal, pending.signal]))
      waitSignal.throwIfAborted()
      return cli.program
    } finally {
      if (--pending.waiters === 0) {
        pending.controller.abort()
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    if (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new CodexAutomationUpdateError('The Codex update timed out.')
    }
    throw error instanceof CodexAutomationUpdateError
      ? error
      : new CodexAutomationUpdateError('Orca could not check this Codex installation.')
  }
}
