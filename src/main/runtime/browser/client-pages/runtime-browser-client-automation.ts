import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { actOnRuntimeBrowserInitialization } from './runtime-browser-page-initialization-action'
import { isSameBrowserUrl } from '../../../../shared/browser/client-hosting/browser-expected-url'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserError } from '../../../browser/browser-error'
import {
  browserClientPageRefusal,
  readableBrowserClientPageRefusal
} from './browser-client-page-refusal-copy'
import { browserExpectedUrlMismatchError } from '../../../browser/cdp/input/browser-expected-page-url'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { isAgentRpcCaller, type RpcCallerIdentity } from '../../rpc/callers/rpc-caller-identity'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../shared/file-access/cross-platform-path'

export type ClientHostedBrowserRpcRoute = { handled: false } | { handled: true; result: unknown }

export async function routeRuntimeBrowserClientAutomation(options: {
  method: string
  params: unknown
  caller: RpcCallerIdentity | undefined
  pages: RuntimeBrowserPageRegistry
  leases: BrowserHostLeaseRegistry
  resolveExecutionHostKey?(workspaceId: string): Promise<BrowserExecutionHostKeyResolution>
  notifyWorkspace?(workspaceId: string): void
  resolveWorkspace(selector: string): Promise<{ id: string }>
  resolveWorkspacePath(workspaceId: string): Promise<string>
}): Promise<ClientHostedBrowserRpcRoute> {
  const method = BrowserClientAutomationMethod.safeParse(options.method)
  if (!method.success || !isRecord(options.params)) {
    return { handled: false }
  }
  const page = await resolveTargetPage(options.params, options.pages, options.resolveWorkspace)
  if (!page) {
    return { handled: false }
  }
  if (
    method.data === 'browser.goto' &&
    typeof options.params.url === 'string' &&
    options.leases.clientPageInitializations.lease(page.browserPageId, page.placement) &&
    options.resolveExecutionHostKey &&
    options.notifyWorkspace
  ) {
    if (
      typeof options.params.expectUrl === 'string' &&
      !isSameBrowserUrl(options.params.expectUrl, page.url)
    ) {
      throw browserExpectedUrlMismatchError({
        expectedUrl: options.params.expectUrl,
        actualUrl: page.url,
        browserPageId: page.browserPageId,
        mayHaveStarted: false
      })
    }
    const url = await actOnRuntimeBrowserInitialization({
      pages: options.pages,
      authority: options.leases,
      page,
      action: { type: 'navigate', url: options.params.url },
      resolveExecutionHostKey: options.resolveExecutionHostKey,
      notifyWorkspace: options.notifyWorkspace
    })
    const current = options.pages.getPage(page.browserPageId)
    if (!current || !url) {
      throw new Error('browser_page_placement_stale')
    }
    return { handled: true, result: { url, title: current.title } }
  }
  const params =
    method.data === 'browser.upload'
      ? await toWorkspaceRelativeUploadParams(options.params, () =>
          options.resolveWorkspacePath(page.workspaceId)
        )
      : options.params
  let issued: ReturnType<BrowserHostLeaseRegistry['issueClientPageCommand']>
  try {
    issued = options.leases.issueClientPageCommand(
      {
        authorityRuntimeId: options.leases.authorityRuntimeId,
        authorityEpoch: options.leases.authorityEpoch,
        browserPageId: page.browserPageId,
        browserHostClientId: page.placement.browserHostClientId,
        browserHostGeneration: page.placement.browserHostGeneration,
        pageHostGeneration: page.placement.pageHostGeneration
      },
      {
        type: 'automation',
        method: method.data,
        params,
        // A person's link or relayed input must not light the desktop page as agent-driven.
        agent: isAgentRpcCaller(options.caller),
        stagedResults: true
      }
    )
  } catch (error) {
    throw readableBrowserClientPageRefusal(error)
  }
  const result = await issued.result
  if (result.status === 'failed') {
    throw result.expectedUrlMismatch
      ? browserExpectedUrlMismatchError(result.expectedUrlMismatch)
      : browserClientPageRefusal(result.errorCode, result.errorMessage)
  }
  return { handled: true, result: result.value }
}

async function resolveTargetPage(
  params: Record<string, unknown>,
  pages: RuntimeBrowserPageRegistry,
  resolveWorkspace: (selector: string) => Promise<{ id: string }>
) {
  if (typeof params.page === 'string' && params.page.length > 0) {
    return pages.getPage(params.page)
  }
  if (typeof params.worktree !== 'string' || params.worktree.length === 0) {
    return undefined
  }
  const workspace = await resolveWorkspace(params.worktree)
  return pages.listPages(workspace.id).find((page) => page.active)
}

/** The client host reads upload files by workspace-relative path; the CLI sends absolute ones. */
async function toWorkspaceRelativeUploadParams(
  params: Record<string, unknown>,
  resolveWorkspacePath: () => Promise<string>
): Promise<Record<string, unknown>> {
  const isAbsolute = (file: unknown): file is string =>
    typeof file === 'string' && (file.startsWith('/') || isWindowsAbsolutePathLike(file))
  if (!Array.isArray(params.files) || !params.files.some(isAbsolute)) {
    return params
  }
  const requested: unknown[] = params.files
  const root = await resolveWorkspacePath()
  const files: unknown[] = []
  for (const file of requested) {
    // Older CLIs and paired callers already send workspace-relative paths.
    if (!isAbsolute(file)) {
      files.push(file)
      continue
    }
    // Collapse `..` so an escaping path gets this refusal, not the file reader's generic one.
    const normalized = isWindowsAbsolutePathLike(file)
      ? win32.normalize(file)
      : posix.normalize(file)
    // The CLI's cwd is physical, so a workspace saved under a symlink only matches once resolved.
    const relative =
      relativePathInsideRoot(root, normalized) ||
      relativePathInsideRoot(await realpathOrSelf(root), await realpathOrSelf(normalized))
    if (!relative) {
      throw new BrowserError(
        'invalid_argument',
        `Cannot upload ${file}: this page runs on another device, so it can only upload files inside the workspace ${root}`
      )
    }
    files.push(relative)
  }
  return { ...params, files }
}

function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
