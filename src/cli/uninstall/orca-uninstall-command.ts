import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { rejectRemoteSelectionFlags } from '../dispatch/remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { getDefaultUserDataPath } from '../runtime/profile/metadata'
import { ensureCliAppEnvironment } from '../runtime/profile/cli-app-environment'
import { createTerminalConfirm } from '../plugins/dev-watch/plugin-dev-watch-approval'
import {
  ORCA_UNINSTALL_STEPS,
  type OrcaUninstallEntryState,
  type OrcaUninstallPlan
} from '../../shared/uninstall/orca-uninstall-types'
import type { OrcaUninstallHost } from '../../main/uninstall/orca-uninstall-cleanup'
import type { CliInstallerOptions } from '../../main/cli/installation/cli-installer-contracts'

type PackagedLayout = { resourcesPath: string; exePath: string }

// The bundled launcher runs <resources>/app.asar.unpacked/out/cli/index.js.
function packagedLayout(scriptPath: string | undefined): PackagedLayout | null {
  const marker = `${sep}app.asar.unpacked${sep}`
  const index = scriptPath?.indexOf(marker) ?? -1
  if (!scriptPath || index === -1) {
    return null
  }
  const resourcesPath = scriptPath.slice(0, index)
  const root = dirname(resourcesPath)
  const exePath =
    process.platform === 'darwin'
      ? join(root, 'MacOS', 'Orca')
      : process.platform === 'win32'
        ? join(root, 'Orca.exe')
        : join(root, 'orca-ide')
  return { resourcesPath, exePath }
}

function linuxPackageType(layout: PackagedLayout | null): 'deb' | 'rpm' | null {
  if (process.platform !== 'linux' || !layout) {
    return null
  }
  try {
    const marker = readFileSync(join(layout.resourcesPath, 'package-type'), 'utf8').trim()
    return marker === 'deb' || marker === 'rpm' ? marker : null
  } catch {
    return null
  }
}

async function createCliHost(client: RuntimeClient): Promise<OrcaUninstallHost> {
  const layout = packagedLayout(process.argv[1])
  const [{ resolveOrcaInstallIdentity }, { CliInstaller }, { persistAgentStatusHooksEnabled }] =
    await Promise.all([
      import('../../main/uninstall/orca-install-identity.js'),
      import('../../main/cli/cli-installer.js'),
      import('../agents/agent-hooks.js')
    ])
  // Without the app's own layout the installer cannot tell Orca's command from someone else's.
  const installerOptions: CliInstallerOptions | null = layout
    ? {
        isPackaged: true,
        userDataPath: getDefaultUserDataPath(),
        resourcesPath: layout.resourcesPath,
        execPath: layout.exePath,
        appPath: join(layout.resourcesPath, 'app.asar')
      }
    : null
  return {
    platform: process.platform,
    homeDir: homedir(),
    userDataPath: getDefaultUserDataPath(),
    uid: process.getuid?.() ?? 0,
    identity: await resolveOrcaInstallIdentity({
      platform: process.platform,
      isPackaged: layout !== null,
      exePath: layout?.exePath ?? process.execPath,
      homeDir: homedir(),
      env: process.env,
      linuxPackageType: linuxPackageType(layout)
    }),
    disableAgentStatusHooks: () => persistAgentStatusHooksEnabled(client, false),
    getCliStatus: async () =>
      installerOptions ? new CliInstaller(installerOptions).getStatus() : null,
    removeCli: async () => {
      if (!installerOptions) {
        throw new Error('Remove the command from Orca Settings instead.')
      }
      return new CliInstaller(installerOptions).remove()
    },
    // The app reaches SSH hosts; here each host runs `orca uninstall` itself.
    listHosts: async () => [],
    removeHostHooks: async () => {
      throw new Error('SSH hosts are removed from the Orca app.')
    }
  }
}

function hasWork(plan: OrcaUninstallPlan): boolean {
  return (
    plan.agents.length > 0 ||
    plan.cliCommand !== null ||
    plan.backgroundService !== null ||
    plan.hookScripts !== null ||
    plan.hosts.length > 0
  )
}

function hasUnfinishedEntry(plan: OrcaUninstallPlan): boolean {
  const entries = [
    ...plan.agents,
    ...plan.hosts,
    ...[plan.cliCommand, plan.backgroundService, plan.hookScripts].filter((entry) => entry !== null)
  ]
  return entries.some((entry) => entry.state === 'error' || entry.state === 'needs-user')
}

const STATE_LABELS: Record<OrcaUninstallEntryState, string> = {
  present: 'will be removed',
  removed: 'removed',
  'kept-shared': 'kept',
  'needs-user': 'needs you',
  error: 'failed'
}

function line(
  label: string,
  location: string,
  state: OrcaUninstallEntryState,
  detail: string | null
): string {
  return `  ${label}: ${location} (${STATE_LABELS[state]}${detail ? `: ${detail}` : ''})`
}

export function formatOrcaUninstallPlan(plan: OrcaUninstallPlan): string {
  const lines = [
    ...plan.agents.map((entry) =>
      line(
        `${entry.agent} hooks`,
        entry.paths.map((each) => each.path).join(', '),
        entry.state,
        entry.detail
      )
    ),
    ...(plan.cliCommand
      ? [
          line(
            `${plan.cliCommand.commandName} command`,
            plan.cliCommand.location,
            plan.cliCommand.state,
            plan.cliCommand.detail
          )
        ]
      : []),
    ...(plan.backgroundService
      ? [
          line(
            'Background service',
            plan.backgroundService.location,
            plan.backgroundService.state,
            plan.backgroundService.detail
          )
        ]
      : []),
    ...(plan.hookScripts
      ? [
          line(
            'Hook scripts',
            plan.hookScripts.location,
            plan.hookScripts.state,
            plan.hookScripts.detail
          )
        ]
      : []),
    ...plan.hosts.map((entry) =>
      line(
        `SSH host ${entry.label}`,
        entry.manualCommand ? `run \`${entry.manualCommand}\` there` : entry.hostId,
        entry.state,
        entry.detail
      )
    )
  ]
  return lines.length > 0 ? lines.join('\n') : '  Nothing outside Orca to remove.'
}

/** The last thing the user does; Orca never deletes the app itself. */
export function formatRemoveAppLine(plan: OrcaUninstallPlan): string {
  switch (plan.installKind) {
    case 'mac-homebrew':
    case 'linux-package':
      return `To delete the app, run: ${plan.removeAppCommand}`
    case 'mac-app':
      return `To delete the app, move ${plan.appPath} to the Trash.`
    case 'windows-installer':
      return 'To delete the app, open Settings > Apps > Installed apps, find Orca and choose Uninstall.'
    case 'linux-appimage':
      return `To delete the app, delete ${plan.appPath}.`
    case 'unknown':
      return 'To delete the app, remove it the way you installed it.'
  }
}

function confirmFor(json: boolean): ((question: string) => Promise<boolean>) | null {
  return !json && process.stdin.isTTY && process.stdout.isTTY
    ? createTerminalConfirm({ input: process.stdin, output: process.stdout })
    : null
}

export const UNINSTALL_HANDLERS: Record<string, CommandHandler> = {
  uninstall: async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(flags, 'uninstall; run it on the machine you want to clean up.')
    // Before main modules load: Claude's remover resolves its profile homes through it.
    ensureCliAppEnvironment()
    const { buildOrcaUninstallPlan, runOrcaUninstallStep } =
      await import('../../main/uninstall/orca-uninstall-cleanup.js')
    const host = await createCliHost(client)
    let plan = await buildOrcaUninstallPlan(host)
    if (hasWork(plan) && flags.get('yes') !== true) {
      const confirm = confirmFor(json)
      if (!confirm) {
        throw new RuntimeClientError(
          'confirmation_required',
          'Removes what Orca added outside its own folders. Re-run with --yes to confirm.',
          { plan }
        )
      }
      const question = [
        'Orca will remove what it added outside its own folders. Your projects, worktrees, chat history and Orca settings stay.',
        formatOrcaUninstallPlan(plan),
        ...(plan.otherOrcaBuildName
          ? [`${plan.otherOrcaBuildName} is still installed, so the shared agent hooks stay.`]
          : []),
        'Continue? [y/N] '
      ].join('\n')
      if (!(await confirm(question))) {
        console.log('Nothing was changed.')
        return
      }
    }
    for (const step of ORCA_UNINSTALL_STEPS) {
      plan = await runOrcaUninstallStep(plan, step, host)
    }
    const removeApp = formatRemoveAppLine(plan)
    const unfinished = hasUnfinishedEntry(plan)
    if (unfinished) {
      process.exitCode = 1
    }
    if (json) {
      console.log(JSON.stringify({ ok: !unfinished, result: { plan, removeApp } }, null, 2))
      return
    }
    console.log([formatOrcaUninstallPlan(plan), removeApp].join('\n'))
  }
}
