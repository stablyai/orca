import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  findPaneCodexOnSharedServer,
  resolveCodexPaneHome
} from '../../../codex/codex-shared-server-pane'
import {
  disableCodexSharedServerAutoStart,
  stopCodexSharedServer
} from '../../../codex/codex-shared-server-fix'
import { getLegacyDaemonAdapters } from '../../../daemon/daemon-provider-routing'
import {
  CODEX_FISH_SHELL_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/daemon-protocol-version'
import type { CodexSharedServerStatus } from '../../../../shared/codex-shared-server-command'
import { ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty, hasPtyProviderForInspection } from '../provider/registry'

// Why per shell: a new terminal fixes Codex only where this build's daemon gives that shell Orca's
// codex function; cmd.exe and unrecognized shells never get one.
const CODEX_SHELL_FUNCTION_PROTOCOL_BY_SHELL: ReadonlyMap<string, number> = new Map([
  ['zsh', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['bash', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['powershell', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['pwsh', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['fish', CODEX_FISH_SHELL_FUNCTION_DAEMON_PROTOCOL_VERSION]
])

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

/** The pane's root pid when it is a local, non-WSL pane; otherwise null. */
async function findLocalPaneRootPid(deps: Deps, id: unknown): Promise<number | null> {
  // Why local only: SSH and WSL panes run Codex on another host, which must answer for itself.
  if (
    typeof id !== 'string' ||
    id.startsWith('remote:') ||
    parseAppSshPtyId(id) ||
    (ptyOwnership.get(id) ?? null) !== null
  ) {
    return null
  }
  // Why: the pre-swap provider does not own restored daemon ids.
  await deps.getLocalPtyProviderStartupPromise()
  if (!hasPtyProviderForInspection(id)) {
    return null
  }
  const session = (await getProviderForPty(id).listProcesses()).find(
    (candidate) => candidate.id === id
  )
  return session?.rootProcessId !== undefined && !session.wslDistro ? session.rootProcessId : null
}

function handleLocalPane<T>(
  deps: Deps,
  channel: string,
  run: (id: string, rootPid: number) => Promise<T>,
  refused: T
): void {
  getPtyIpc().handle(channel, async (_event, args: { id: string }): Promise<T> => {
    try {
      const rootPid = await findLocalPaneRootPid(deps, args?.id)
      return rootPid === null ? refused : await run(args.id, rootPid)
    } catch {
      return refused
    }
  })
}

async function readPaneSharedServerStatus(
  id: string,
  rootPid: number
): Promise<CodexSharedServerStatus> {
  const codex = await findPaneCodexOnSharedServer(id, rootPid)
  if (!codex) {
    return { joined: false }
  }
  // Why: the pane's own daemon predates its shell's codex function, which a new terminal has.
  const shellFunctionProtocol = CODEX_SHELL_FUNCTION_PROTOCOL_BY_SHELL.get(codex.shell ?? '')
  const openedBeforeWrapper =
    shellFunctionProtocol !== undefined &&
    getLegacyDaemonAdapters(getProviderForPty(id)).some(
      (adapter) => adapter.hasPty(id) && adapter.protocolVersion < shellFunctionProtocol
    )
  return { joined: true, openedBeforeWrapper }
}

/** Runs a fix command against the pane's own CODEX_HOME, never a guessed one. */
function runForPaneHome(fix: (codexHome: string) => Promise<boolean>) {
  return async (id: string): Promise<boolean> => {
    const codexHome = resolveCodexPaneHome(id)
    return codexHome ? await fix(codexHome) : false
  }
}

// Why its own read: only a pane already showing Codex asks, so no cadence poll pays for argv.
export function installPtyCodexSharedServerIpcHandler(deps: Deps): void {
  handleLocalPane(deps, 'pty:isCodexOnSharedServer', readPaneSharedServerStatus, { joined: false })
  handleLocalPane(
    deps,
    'pty:disableCodexSharedServerAutoStart',
    runForPaneHome(disableCodexSharedServerAutoStart),
    false
  )
  handleLocalPane(deps, 'pty:stopCodexSharedServer', runForPaneHome(stopCodexSharedServer), false)
}
