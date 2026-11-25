// Every runtimeEnvironments channel registers through here, so each one says what a host shared with
// this account gets: the table below is typed against the full channel list, and a channel added
// without a decision fails the typecheck.
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { RuntimeEnvironmentHandlerChannel } from './runtime-environment-handler-channels'
import {
  resolveRuntimeEnvironmentHost,
  type SharedHostRoute
} from './requests/runtime-environment-shared-hosts'

type SharedHostHandling =
  /** Answered over the share by the shared host's route. */
  | { answer: (route: SharedHostRoute, args: unknown) => Promise<unknown> }
  /** Names no host (or lists every one itself): runs as it is. */
  | 'no-host'
  /** Means nothing for a share (pairing, SSH, managed servers, port forwards): refused for one. */
  | 'paired-only'
  /** Keeps per-window stream state, so its handler resolves the host itself and handles both kinds. */
  | 'routes-own-streams'

const CallArgs = z.object({ method: z.string(), params: z.unknown().optional() })
const StatusArgs = z.object({
  timeoutMs: z.number().optional(),
  observeOnly: z.literal(true).optional(),
  force: z.literal(true).optional()
})

const SHARED_HOST_HANDLING = {
  'runtimeEnvironments:call': {
    answer: async (route, args) => {
      const { method, params } = CallArgs.parse(args)
      return route.call(method, params)
    }
  },
  'runtimeEnvironments:getStatus': {
    answer: (route, args) => route.status(StatusArgs.parse(args))
  },
  'runtimeEnvironments:connect': {
    answer: (route, args) =>
      route.status({ timeoutMs: StatusArgs.parse(args).timeoutMs, reconnect: true })
  },
  'runtimeEnvironments:subscribe': 'routes-own-streams',
  'runtimeEnvironments:unsubscribe': 'no-host',
  // Lists the shared hosts' snapshots beside the paired servers'.
  'runtimeEnvironments:getStatusSnapshots': 'no-host',
  // The paired-server catalog; the window has its own list of shared hosts.
  'runtimeEnvironments:list': 'no-host',
  'runtimeEnvironments:desktopCreatedChatIds': 'no-host',
  'runtimeEnvironments:retryConnectionsNow': 'no-host',
  'runtimeEnvironments:addFromPairingCode': 'no-host',
  'runtimeEnvironments:verifyAndAddFromPairingCode': 'no-host',
  'runtimeEnvironments:listPortForwards': 'no-host',
  'runtimeEnvironments:addPortForward': 'no-host',
  'runtimeEnvironments:updatePortForward': 'no-host',
  'runtimeEnvironments:removePortForward': 'no-host',
  'runtimeEnvironments:deployOrcad': 'no-host',
  'runtimeEnvironments:convertSshHostToManagedOrcad': 'no-host',
  'runtimeEnvironments:listPendingOrcadMigrations': 'no-host',
  'runtimeEnvironments:resolve': 'paired-only',
  'runtimeEnvironments:remove': 'paired-only',
  'runtimeEnvironments:disconnect': 'paired-only',
  'runtimeEnvironments:repairFromPairingCode': 'paired-only',
  'runtimeEnvironments:prepareBrowserClientHostPlacement': 'paired-only',
  'runtimeEnvironments:ensurePortForward': 'paired-only',
  'runtimeEnvironments:linkSshAccess': 'paired-only',
  'runtimeEnvironments:unlinkSshAccess': 'paired-only',
  'runtimeEnvironments:getOrcadStatus': 'paired-only',
  'runtimeEnvironments:updateOrcad': 'paired-only',
  'runtimeEnvironments:rollbackOrcad': 'paired-only',
  'runtimeEnvironments:recoverOrcad': 'paired-only',
  'runtimeEnvironments:restartOrcad': 'paired-only',
  'runtimeEnvironments:reclaimOrcadStaleLock': 'paired-only',
  'runtimeEnvironments:stopOrcad': 'paired-only',
  'runtimeEnvironments:cancelOrcadStop': 'paired-only',
  'runtimeEnvironments:forgetOrcad': 'paired-only',
  'runtimeEnvironments:previewOrcadDeltaMove': 'paired-only',
  'runtimeEnvironments:moveOrcadDelta': 'paired-only',
  'runtimeEnvironments:keepOrcadServerVersion': 'paired-only',
  'runtimeEnvironments:allowOrcadMoveLeavingBehind': 'paired-only'
} satisfies Record<RuntimeEnvironmentHandlerChannel, SharedHostHandling>

/** The host a channel's args name, by the field each channel uses for it. */
function hostSelectorOf(args: unknown): string | null {
  const named = z
    .object({ selector: z.string().optional(), environmentId: z.string().optional() })
    .safeParse(args)
  return named.success ? (named.data.selector ?? named.data.environmentId ?? null) : null
}

type Listener = Parameters<typeof ipcMain.handle>[1]

/** `ipcMain.handle` for a runtimeEnvironments channel: a shared host is answered as the table says. */
export function handleRuntimeEnvironmentChannel(
  channel: RuntimeEnvironmentHandlerChannel,
  listener: Listener
): void {
  const handling: SharedHostHandling = SHARED_HOST_HANDLING[channel]
  ipcMain.handle(channel, async (event, ...args) => {
    const selector =
      typeof handling === 'object' || handling === 'paired-only' ? hostSelectorOf(args[0]) : null
    const host = selector ? await resolveRuntimeEnvironmentHost(selector) : null
    switch (host?.kind) {
      case 'shared':
        if (typeof handling === 'object') {
          return handling.answer(host.route, args[0])
        }
        throw new Error(`${channel} is not available for a host shared with this account.`)
      case 'paired':
      case undefined:
        return listener(event, ...args)
    }
  })
}
