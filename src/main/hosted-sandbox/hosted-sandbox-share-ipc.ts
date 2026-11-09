// IPC for share links (Ports panel). The renderer names an environment; main maps it to the Orca
// Cloud sandbox behind it, so a renderer can only reach sandboxes this profile created.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  CLOUD_SHARE_CHANNELS,
  SHARE_AUDIENCES,
  SHARE_EXPIRIES,
  SHARE_RESERVED_PORTS,
  type CloudShareFailureCode,
  type CloudShareResult,
  type ShareCreateRequest,
  type ShareLink
} from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { translateMain } from '../i18n/main-i18n'
import type { HostedSandboxConfig } from './hosted-sandbox-config'
import { createHostedSandboxRequest } from './hosted-sandbox-control-plane-client'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import {
  createHostedSandboxShareClient,
  shareToken,
  type HostedSandboxShareClient
} from './hosted-sandbox-share-client'
import { disableCloudShareDeepLinks, setCloudShareDeepLinkHandler } from './cloud-share-deep-link'

export function hostedSandboxIdForEnvironment(
  userDataPath: string,
  environmentId: string
): string | null {
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (runtime.runtimeEnvironmentId !== environmentId || !runtime.recipeResult) {
      continue
    }
    const handle = environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    const id = handle?.driverState.sandboxId
    if (typeof id === 'string' && id) {
      return id
    }
  }
  return null
}

function failure(code: CloudShareFailureCode, message: string): CloudShareResult<never> {
  return { ok: false, code, message }
}

function fromError(error: unknown): CloudShareResult<never> {
  if (isEnvironmentProviderError(error)) {
    if (error.code === 'conflict' && error.reason === 'share_limit') {
      return failure('limit', 'This workspace already has the most share links it can have.')
    }
    const code: CloudShareFailureCode =
      error.code === 'unauthorized'
        ? 'unauthorized'
        : error.code === 'not_found'
          ? 'not_found'
          : error.code === 'invalid_request'
            ? 'invalid_request'
            : 'unavailable'
    return failure(code, error.message)
  }
  return failure('unavailable', 'Could not reach Orca Cloud.')
}

const CreateRequest = z
  .object({
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => !SHARE_RESERVED_PORTS.includes(port)),
    audience: z.enum(SHARE_AUDIENCES),
    expiresIn: z.enum(SHARE_EXPIRIES),
    allowWake: z.boolean()
  })
  .strict()

function parseCreate(value: unknown): ShareCreateRequest | null {
  const parsed = CreateRequest.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Only a share link on the control plane (path mode) or on the configured share domain is ever handed
 * to the system browser, whatever the server answered.
 */
export function isShareLinkUrl(
  value: string,
  controlPlaneUrl: string,
  /** ORCA_CLOUD_SHARE_HOST_SUFFIX (e.g. `.share.example.dev`): the only share subdomains accepted. */
  hostSuffix: string | undefined = process.env.ORCA_CLOUD_SHARE_HOST_SUFFIX?.trim() || undefined
): boolean {
  try {
    const url = new URL(value)
    const plane = new URL(controlPlaneUrl)
    const token = shareToken(value)
    if (!token || url.username || url.password) {
      return false
    }
    if (url.origin === plane.origin) {
      return url.pathname.startsWith(`/s/${token}/`)
    }
    return (
      hostSuffix !== undefined &&
      hostSuffix.startsWith('.') &&
      url.protocol === 'https:' &&
      url.hostname === `${token}${hostSuffix}`
    )
  } catch {
    return false
  }
}

/** Registered for every build; without a control plane each call answers `not_cloud`. */
export function registerCloudShareHandlers(
  userDataPath: string,
  config: HostedSandboxConfig | null
): void {
  const client = config
    ? createHostedSandboxShareClient(
        createHostedSandboxRequest({
          baseUrl: config.controlPlaneUrl,
          getAccessToken: config.getAccessToken
        })
      )
    : null
  const withSandbox = async <T>(
    environmentId: unknown,
    work: (sandboxId: string) => Promise<CloudShareResult<T>>
  ): Promise<CloudShareResult<T>> => {
    const sandboxId =
      client && typeof environmentId === 'string'
        ? hostedSandboxIdForEnvironment(userDataPath, environmentId)
        : null
    if (!sandboxId) {
      return failure('not_cloud', 'Share links are available for Orca Cloud workspaces.')
    }
    try {
      return await work(sandboxId)
    } catch (error) {
      return fromError(error)
    }
  }

  for (const channel of Object.values(CLOUD_SHARE_CHANNELS)) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(
    CLOUD_SHARE_CHANNELS.list,
    (
      _event,
      args: { environmentId?: unknown }
    ): Promise<CloudShareResult<{ shares: ShareLink[] }>> =>
      withSandbox(args?.environmentId, async (sandboxId) => ({
        ok: true,
        shares: await client!.list(sandboxId)
      }))
  )
  ipcMain.handle(
    CLOUD_SHARE_CHANNELS.create,
    (
      _event,
      args: { environmentId?: unknown; request?: unknown }
    ): Promise<CloudShareResult<{ share: ShareLink }>> =>
      withSandbox(args?.environmentId, async (sandboxId) => {
        const request = parseCreate(args?.request)
        if (!request) {
          return failure('invalid_request', 'That port or option can’t be shared.')
        }
        return { ok: true, share: await client!.create(sandboxId, request) }
      })
  )
  ipcMain.handle(
    CLOUD_SHARE_CHANNELS.revoke,
    (
      _event,
      args: { environmentId?: unknown; shareId?: unknown }
    ): Promise<CloudShareResult<{ share: ShareLink }>> =>
      withSandbox(args?.environmentId, async (sandboxId) => {
        if (typeof args?.shareId !== 'string' || !/^[0-9a-f]{32}$/.test(args.shareId)) {
          return failure('invalid_request', 'Unknown share link.')
        }
        return { ok: true, share: await client!.revoke(sandboxId, args.shareId) }
      })
  )
  ipcMain.handle(
    CLOUD_SHARE_CHANNELS.open,
    (
      _event,
      args: { environmentId?: unknown; shareId?: unknown }
    ): Promise<CloudShareResult<Record<never, never>>> =>
      withSandbox(args?.environmentId, async (sandboxId) => {
        // Only this workspace's own active links open; the renderer never names a URL.
        const share = (await client!.list(sandboxId)).find((item) => item.id === args?.shareId)
        if (!share || share.state !== 'active') {
          return failure('not_found', 'That link is no longer active.')
        }
        // Team-only links need this user's one-time sign-in; public ones open as they are.
        const target = share.audience === 'team' ? await client!.visitUrl(share.url) : share.url
        if (!isShareLinkUrl(target, config!.controlPlaneUrl)) {
          return failure('invalid_request', 'Orca Cloud returned an unexpected link.')
        }
        await shell.openExternal(target)
        return { ok: true }
      })
  )

  if (client && config) {
    setCloudShareDeepLinkHandler((token) => void openDeepLink(client, config, token))
  } else {
    disableCloudShareDeepLinks()
  }
}

/** The team-only page's "Open in Orca": sign this user in for that link, or say why not. */
async function openDeepLink(
  client: HostedSandboxShareClient,
  config: HostedSandboxConfig,
  token: string
): Promise<void> {
  const base = config.controlPlaneUrl.endsWith('/')
    ? config.controlPlaneUrl
    : `${config.controlPlaneUrl}/`
  try {
    const target = await client.visitUrl(new URL(`s/${token}/`, base).toString())
    if (!isShareLinkUrl(target, config.controlPlaneUrl)) {
      throw new Error('unexpected share link')
    }
    await shell.openExternal(target)
  } catch (error) {
    // Reopening the page would only show "Open in Orca" again; explain here instead.
    const reason = isEnvironmentProviderError(error) ? error.reason : null
    const code = isEnvironmentProviderError(error) ? error.code : null
    const detail =
      reason === 'not_in_team'
        ? translateMain(
            'cloudShare.openFailed.notInTeam',
            'You’re not on the team this preview is shared with. Ask the owner for access or a public link.'
          )
        : code === 'unauthorized'
          ? translateMain(
              'cloudShare.openFailed.signIn',
              'Sign in to Orca, then open the shared preview again.'
            )
          : code === 'not_found'
            ? translateMain(
                'cloudShare.openFailed.ended',
                'That shared preview is no longer active.'
              )
            : translateMain(
                'cloudShare.openFailed.unreachable',
                'Couldn’t reach Orca Cloud. Try again in a moment.'
              )
    // The user is in the browser; bring Orca forward so the explanation isn't hidden behind it.
    const parent = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    parent?.show()
    parent?.focus()
    if (process.platform === 'darwin') {
      app.focus({ steal: true })
    }
    const options = {
      type: 'info' as const,
      message: translateMain('cloudShare.openFailed.title', 'Couldn’t open the shared preview'),
      detail,
      buttons: [translateMain('cloudShare.openFailed.ok', 'OK')]
    }
    await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).catch(
      () => undefined
    )
  }
}
